import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.0';
import { assessEvidence } from './ai_engine.ts';
import { modelAssist, aiLastFailure, aiLastFailureKind, aiCircuitSnapshot } from './ai_provider.ts';
import { bmoni, bmoniConfigured, normalizePhone, bmoniUserIdFrom, findBmoniUserIdByEmail } from './bmoni.ts';
import { verifyRelayBody } from './relay_verify.ts';

const allowedOrigins = (Deno.env.get('REACH_ALLOWED_ORIGINS') || 'http://localhost:5173,http://localhost:5500').split(',').map(v => v.trim()).filter(Boolean);
function corsFor(req: Request) {
  const origin = req.headers.get('Origin') || '';
  // Production: explicit allow-list only. Wildcard is rejected for credentialed API use.
  const allowStar = allowedOrigins.length === 1 && allowedOrigins[0] === '*' && (Deno.env.get('REACH_ALLOW_STAR_CORS') === 'true');
  const allowed = allowedOrigins.includes(origin) ? origin : (allowStar ? '*' : '');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = allowed;
  return headers;
}

const MAX_JSON_BODY = 256 * 1024; // 256 KiB general API JSON
const MAX_DESCRIPTION = 4000;
const MAX_RELAY_PACKET = 64 * 1024;
// Fallback institutional subscription price (decimal CNGN) used only when
// REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN is not set on the server.
const DEFAULT_SUBSCRIPTION_AMOUNT_CNGN = '14500';

function rateLimitFor(path: string, method: string): { limit: number; window: number } {
  if (path.startsWith('/webhooks/')) return { limit: 120, window: 60 };
  if (path.includes('/payment') || path.includes('/bmoni')) return { limit: 20, window: 60 };
  if (path.includes('/relay')) return { limit: 60, window: 60 };
  if (path === '/incidents' && method === 'POST') return { limit: 15, window: 60 };
  if (path.includes('/operator')) return { limit: 20, window: 60 };
  if (path.includes('/ai') || path.includes('/assess')) return { limit: 30, window: 60 };
  if (method === 'GET') return { limit: 120, window: 60 };
  return { limit: 40, window: 60 };
}

async function readJsonLimited(req: Request, maxBytes = MAX_JSON_BODY): Promise<any> {
  const raw = await req.text();
  if (raw.length > maxBytes) {
    const err = new Error('Request body too large');
    (err as any).status = 413;
    throw err;
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    const err = new Error('Invalid JSON body');
    (err as any).status = 400;
    throw err;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const allowedCategories = new Set(['medical', 'fire', 'security', 'accident', 'other']);
const allowedPriorities = new Set(['low', 'medium', 'high', 'critical']);
const allowedChannels = new Set(['pwa', 'web', 'ussd', 'sms', 'voice', 'ivr', 'relay', 'human-relay', 'operator']);
const allowedStatuses = new Set(['reported', 'received', 'verifying', 'verified', 'assigned', 'responding', 'on_scene', 'resolved', 'closed', 'cancelled']);

function textValue(value: unknown, max = 1000): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v ? v.slice(0, max) : null;
}

function numberValue(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function requireUuid(value: string | null): string {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid resource id');
  return value;
}

/** Resolve the BMONI `bmoniUserId` for an institution, healing a row that stored the
 *  wrapper's internal `id` (which every user-scoped endpoint rejects with 404 "User not
 *  found"). When a call against the stored id 404s and the row still has the payer email,
 *  look the user up by email and persist the corrected id; otherwise rethrow.
 *
 *  `run` must not mutate anything before its first BMONI call, so a retry is safe. */
async function withBmoniUserId(
  account: { bmoni_user_id: string | null; metadata?: any },
  run: (bmoniUserId: string) => Promise<any>,
  persist: (healed: string, storedId: string) => Promise<void>,
): Promise<any> {
  try {
    return await run(String(account.bmoni_user_id));
  } catch (error: any) {
    const storedId = String(account.bmoni_user_id);
    const payerEmail = account?.metadata?.payer_email;
    if (error?.status !== 404 || !payerEmail) throw error;
    const healed = await findBmoniUserIdByEmail(payerEmail);
    if (!healed || healed === storedId) throw error;
    await persist(healed, storedId);
    return await run(healed);
  }
}

/** Derive the deterministic engine's evidence set from an incident that already exists.
 *
 * Nothing ever wrote to incident_evidence, so every assessment fused an empty set and abstained
 * with `no_usable_evidence`. These items are a projection of what the incident already records --
 * not independent observations -- so they are kept deliberately weak: a single `user_report` at a
 * moderate confidence cannot on its own reach the 60% confidence threshold. That keeps the
 * abstention behaviour intact while giving the engine something real to reason about, and leaves
 * the strong kinds (corroboration, sensor, image) for genuine evidence captured at the source.
 *
 * The derived rows are persisted through ingest_incident_evidence_service on the service-role path
 * (RLS forbids this derivation), then read back so the engine fuses exactly what is stored. */
function deriveEvidenceFromIncident(incident: any, description: string | null, reportedCategory: string | null) {
  const evidence: any[] = [];
  const category = reportedCategory ?? incident.category ?? undefined;
  const base = {
    category: allowedCategories.has(category) ? category : undefined,
    timestamp: incident.reported_at,
  };
  evidence.push({ kind: 'user_report', confidence: 60, quality: 1, ...base });
  if (description) evidence.push({ kind: 'text', confidence: 55, quality: 1, ...base });
  // One location item, not two: the engine dedupes on kind|source|timestamp|category, so a second
  // item with the same fields would be dropped and its higher confidence lost.
  if (incident.location_label || incident.location_accuracy_m != null) {
    const precise = incident.location_accuracy_m != null && Number(incident.location_accuracy_m) <= 100;
    evidence.push({ kind: 'location', confidence: precise ? 60 : 40, quality: 1, ...base });
  }
  // A relay packet is a weaker channel than a direct PWA report.
  if (incident.via_relay) evidence.push({ kind: 'relay', confidence: 50, quality: 1, ...base });
  return evidence;
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200, headers: Record<string,string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors, ...headers } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const serviceSupabase = serviceRoleKey ? createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey) : null;
  const requireService = () => { if (!serviceSupabase) throw new Error('Server service-role configuration is missing'); return serviceSupabase; };

  if (path === '/health' && req.method === 'GET') {
    return json({ ok: true, service: 'reach-api', time: new Date().toISOString() });
  }


  if (path === '/webhooks/bmoni' && req.method === 'POST') {
    // Official BMONI contract: X-Webhook-Signature = hex(HMAC-SHA256(secretKey, rawBody))
    // X-Webhook-Id = body.id; Body: { id, eventType, payload, timestamp }
    // Legacy x-bmoni-* headers retained as fallback.
    const service = requireService();
    const rawBody = await req.text();
    if (rawBody.length > 512 * 1024) return json({ error: 'Webhook body too large' }, 413);
    const signature = req.headers.get('x-webhook-signature')
      || req.headers.get('x-bmoni-signature')
      || req.headers.get('x-signature')
      || '';
    const webhookSecret = Deno.env.get('BMONI_WEBHOOK_SECRET') || '';
    if (!webhookSecret || !signature) return json({ error: 'Webhook verification is not configured' }, 503);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const rawDigest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
    const expectedHex = Array.from(rawDigest).map(b => b.toString(16).padStart(2, '0')).join('');
    const supplied = signature.replace(/^sha256=/i, '').trim().toLowerCase();
    let valid = supplied.length === expectedHex.length;
    if (valid) {
      let diff = 0;
      for (let i = 0; i < expectedHex.length; i++) diff |= supplied.charCodeAt(i) ^ expectedHex.charCodeAt(i);
      valid = diff === 0;
    }
    if (!valid) return json({ error: 'Invalid webhook signature' }, 401);
    let payload: any = {};
    try { payload = JSON.parse(rawBody); } catch { return json({ error: 'Invalid webhook JSON' }, 400); }
    const eventType = String(payload.eventType || req.headers.get('x-bmoni-event-type') || 'unknown').slice(0, 120);
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(rawBody));
    const fallbackEventId = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    const eventId = String(
      payload.id
      || req.headers.get('x-webhook-id')
      || req.headers.get('x-bmoni-event-id')
      || req.headers.get('x-event-id')
      || fallbackEventId
    ).slice(0, 200);
    const existing = await service.from('bmoni_webhook_events').select('id,processed_at,attempt_count').eq('event_id', eventId).maybeSingle();
    if (existing.data?.processed_at) return json({ ok: true, duplicate: true, processed: true });
    // Durable inbox first — ACK provider only after signature verified + row persisted
    if (!existing.data) {
      const inserted = await service.from('bmoni_webhook_events').insert({
        event_id: eventId,
        event_type: eventType,
        signature_verified: true,
        payload,
        attempt_count: 0,
      });
      if (inserted.error && !String(inserted.error.message || '').toLowerCase().includes('duplicate')) throw inserted.error;
    }
    // Track attempt; process synchronously but keep processed_at null on failure for provider retry
    await service.from('bmoni_webhook_events').update({
      attempt_count: (existing.data?.attempt_count ?? 0) + 1,
      last_attempt_at: new Date().toISOString(),
    }).eq('event_id', eventId).is('processed_at', null);
    const proposalId = payload?.proposalId || payload?.proposal?.id || payload?.data?.proposalId || payload?.data?.proposal?.id;
    const providerTransactionId = payload?.transactionId || payload?.transaction?.id || payload?.data?.transactionId || payload?.data?.transaction?.id;
    const statusRaw = String(payload?.status || payload?.data?.status || payload?.eventType || '').toLowerCase();
    try {
      const result = await service.rpc('process_bmoni_webhook_event', {
        p_event_id: eventId,
        p_proposal_id: proposalId ? String(proposalId) : null,
        p_provider_transaction_id: providerTransactionId ? String(providerTransactionId) : null,
        p_status: statusRaw,
        p_payload: payload,
      });
      if (result.error) throw result.error;
      return json({ ok: true, ...(result.data || {}) });
    } catch (error) {
      // Inbox retained; provider may retry. processing_error set inside RPC when possible.
      await service.from('bmoni_webhook_events').update({
        processing_error: String(error instanceof Error ? error.message : (error as any)?.message ?? error).slice(0, 1000),
        next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      }).eq('event_id', eventId).is('processed_at', null);
      return json({ error: 'Webhook processing failed; retry is required' }, 500);
    }
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'Authentication required' }, 401);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id,full_name,role,institution_id,relay_enabled')
    .eq('id', user.id)
    .single();
  if (profileError || !profile) return json({ error: 'Profile not found' }, 403);

  const rl = rateLimitFor(path, req.method);
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('cf-connecting-ip') || 'unknown';
  const rateLimit = await supabase.rpc('check_reach_rate_limit', {
    p_bucket_key: `${user.id}:${clientIp}:${req.method}:${path.split('/').slice(0, 4).join('/')}`,
    p_limit: rl.limit,
    p_window_seconds: rl.window,
  });
  if (rateLimit.error) throw rateLimit.error;
  if (rateLimit.data === false) return json({ error: 'Rate limit exceeded. Please retry shortly.' }, 429);

  try {
    if (path === '/devices/register' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const deviceId = textValue(body.device_id, 160);
      const publicKey = textValue(body.public_key, 4096);
      if (!deviceId || !publicKey) return json({ error: 'device_id and public_key are required' }, 422);
      const { data, error } = await supabase.rpc('register_my_relay_device', {
        p_device_id: deviceId,
        p_public_key: publicKey,
        p_platform: textValue(body.platform, 40) ?? 'android',
        p_metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
      });
      if (error) throw error;
      return json({ data }, 201);
    }

    if (path === '/me' && req.method === 'GET') return json({ data: { ...profile, email: user.email } });
    if (path === '/me' && req.method === 'PATCH') {
      const body = await readJsonLimited(req);
      const patch: Record<string, unknown> = {};
      if (body.full_name !== undefined) patch.full_name = textValue(body.full_name, 160) || profile.full_name;
      if (body.phone !== undefined) patch.phone = textValue(body.phone, 40);
      if (body.relay_enabled !== undefined) patch.relay_enabled = Boolean(body.relay_enabled);
      const { data, error } = await supabase.from('profiles').update(patch).eq('id', user.id).select('id,full_name,phone,role,institution_id,relay_enabled').single();
      if (error) throw error;
      return json({ data });
    }


    // Bootstrap-only: permanent key allowed solely when zero operators exist (initial install).
    if (path === '/operator/provision' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const service = requireService();
      const { count } = await service.from('profiles').select('id', { count: 'exact', head: true }).in('role', ['operator', 'super-admin']);
      if ((count ?? 0) > 0) {
        return json({ error: 'Operator provisioning key is disabled after the first operator exists. Use a single-use operator invitation.' }, 403);
      }
      const configuredKey = Deno.env.get('REACH_OPERATOR_PROVISION_KEY');
      if (!configuredKey || typeof body.key !== 'string' || body.key.length < 32 || body.key !== configuredKey) return json({ error: 'Invalid operator provisioning key' }, 403);
      if (profile.role !== 'citizen' || profile.institution_id) return json({ error: 'Only an unassigned account can be provisioned' }, 403);
      const { data, error } = await service.from('profiles').update({ role: 'super-admin', institution_id: null }).eq('id', user.id).eq('role', 'citizen').is('institution_id', null).select('id,role,institution_id,full_name').single();
      if (error) throw error;
      await service.from('audit_logs').insert({ actor_id: user.id, action: 'operator.bootstrap', resource_type: 'profile', resource_id: user.id, metadata: { source: 'bootstrap_provisioning_key' } });
      return json({ data });
    }

    // Super-admin creates single-use operator invitation
    if (path === '/operator/invitations' && req.method === 'POST') {
      if (!['super-admin', 'operator'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      // Only super-admin may invite by default; operators restricted unless flagged
      if (profile.role !== 'super-admin') return json({ error: 'Only super-admin can create operator invitations' }, 403);
      const body = await readJsonLimited(req);
      const email = textValue(body.email, 200)?.toLowerCase();
      if (!email || !email.includes('@')) return json({ error: 'Valid email is required' }, 422);
      const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const service = requireService();
      const { data, error } = await service.from('operator_invitations').insert({
        email,
        token_hash: tokenHash,
        invited_by: user.id,
        status: 'pending',
        expires_at: expiresAt,
      }).select('id,email,status,expires_at,created_at').single();
      if (error) throw error;
      await service.from('audit_logs').insert({ actor_id: user.id, action: 'operator.invitation_created', resource_type: 'operator_invitation', resource_id: data.id, metadata: { email } });
      // Return raw token once; only hash is stored
      return json({ data: { ...data, token } }, 201);
    }

    // Accept operator invitation (single-use, email-bound, expired rejected)
    if (path === '/operator/invitations/accept' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (token.length < 32) return json({ error: 'Invalid invitation token' }, 422);
      if (profile.role !== 'citizen' || profile.institution_id) return json({ error: 'Only an unassigned citizen account can accept an operator invitation' }, 403);
      const tokenHash = await sha256Hex(token);
      const service = requireService();
      const { data: inv, error: invErr } = await service.from('operator_invitations').select('*').eq('token_hash', tokenHash).maybeSingle();
      if (invErr) throw invErr;
      if (!inv || inv.status !== 'pending') return json({ error: 'Invitation not found or already used' }, 404);
      if (new Date(inv.expires_at).getTime() < Date.now()) {
        await service.from('operator_invitations').update({ status: 'expired' }).eq('id', inv.id);
        return json({ error: 'Invitation has expired' }, 410);
      }
      const userEmail = (user.email || '').toLowerCase();
      if (userEmail !== String(inv.email).toLowerCase()) return json({ error: 'Invitation email does not match signed-in user' }, 403);
      const { data, error } = await service.from('profiles').update({ role: 'operator', institution_id: null }).eq('id', user.id).eq('role', 'citizen').is('institution_id', null).select('id,role,institution_id,full_name').single();
      if (error) throw error;
      await service.from('operator_invitations').update({ status: 'accepted', accepted_at: new Date().toISOString(), accepted_user_id: user.id }).eq('id', inv.id).eq('status', 'pending');
      await service.from('audit_logs').insert({ actor_id: user.id, action: 'operator.invitation_accepted', resource_type: 'operator_invitation', resource_id: inv.id, metadata: {} });
      return json({ data });
    }

    if (path === '/operator/invitations' && req.method === 'GET') {
      if (profile.role !== 'super-admin') return json({ error: 'Not permitted' }, 403);
      const { data, error } = await requireService().from('operator_invitations').select('id,email,status,expires_at,accepted_at,created_at,revoked_at').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    if (path === '/institutions' && req.method === 'POST') {
      if (profile.role !== 'citizen') return json({ error: 'Only an unassigned citizen can create an institution' }, 403);
      const body = await readJsonLimited(req);
      const name = textValue(body.name, 160);
      if (!name) return json({ error: 'Institution name is required' }, 422);
      const { data, error } = await supabase.rpc('create_institution_for_current_user', {
        p_name: name,
        p_category: textValue(body.category, 80) ?? 'community',
        p_city: textValue(body.city, 80),
        p_address: textValue(body.address, 240),
      });
      if (error) throw error;
      return json({ institution_id: data }, 201);
    }

    if (path === '/invites' && req.method === 'POST') {
      if (profile.role !== 'institution') return json({ error: 'Institution admin role required' }, 403);
      const body = await readJsonLimited(req);
      const email = textValue(body.email, 254)?.toLowerCase();
      const role = textValue(body.role, 30);
      if (!email || !email.includes('@')) return json({ error: 'Valid email is required' }, 422);
      if (role !== 'staff' && role !== 'security-desk') return json({ error: 'Invalid invite role' }, 422);
      const { data, error } = await supabase.rpc('create_staff_invite', {
        p_email: email, p_role: role, p_expires_hours: Math.min(Math.max(Number(body.expires_hours ?? 72), 1), 168),
      });
      if (error) throw error;
      return json({ code: data }, 201);
    }

    if (path === '/invites/redeem' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const code = textValue(body.code, 80);
      if (!code) return json({ error: 'Invite code is required' }, 422);
      const { data, error } = await supabase.rpc('redeem_staff_invite', { p_code: code });
      if (error) throw error;
      return json({ data });
    }

    if (path === '/incidents' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 100);
      const status = textValue(url.searchParams.get('status'), 30);
      if (status && !allowedStatuses.has(status)) return json({ error: 'Invalid status' }, 422);
      let query = supabase.from('incidents').select('id,code,institution_id,reporter_id,category,status,priority,title,description,source_channel,delivery_method,location_label,location_source,location_accuracy_m,location_context,ai_confidence,ai_fp_code,auto_pushed,via_relay,reported_at,acknowledged_at,resolved_at,closed_at,created_at,updated_at').order('reported_at', { ascending: false }).limit(limit);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    if (path === '/incidents' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const idempotencyKey = textValue(req.headers.get('x-idempotency-key') ?? body.idempotency_key, 160) ?? crypto.randomUUID();
      const category = textValue(body.category, 30)?.toLowerCase() ?? 'other';
      const priority = textValue(body.priority, 20)?.toLowerCase() ?? 'high';
      const sourceChannel = textValue(body.source_channel, 30)?.toLowerCase() ?? 'pwa';
      if (!allowedCategories.has(category)) return json({ error: 'Invalid incident category' }, 422);
      if (!allowedPriorities.has(priority)) return json({ error: 'Invalid incident priority' }, 422);
      if (!allowedChannels.has(sourceChannel)) return json({ error: 'Invalid source channel' }, 422);
      const lat = numberValue(body.latitude, -90, 90);
      const lng = numberValue(body.longitude, -180, 180);
      if ((body.latitude != null || body.longitude != null) && (lat === null || lng === null)) return json({ error: 'Invalid coordinates' }, 422);
      const confidence = body.ai_confidence == null ? null : numberValue(body.ai_confidence, 0, 100);
      if (body.ai_confidence != null && confidence === null) return json({ error: 'Invalid AI confidence' }, 422);

      const payload = {
        category, priority, source_channel: sourceChannel,
        title: textValue(body.title, 160), description: textValue(body.description, 4000),
        delivery_method: textValue(body.delivery_method, 80), location_label: textValue(body.location_label, 240),
        location_source: textValue(body.location_source, 30), location_accuracy_m: numberValue(body.location_accuracy_m, 0, 100000),
        latitude: lat, longitude: lng, location_context: typeof body.location_context === 'object' && body.location_context ? body.location_context : {},
        ai_confidence: confidence, ai_fp_code: textValue(body.ai_fp_code, 80), via_relay: Boolean(body.via_relay),
      };
      const { data, error } = await supabase.rpc('create_incident_for_current_user', { p_payload: payload, p_idempotency_key: idempotencyKey });
      if (error) throw error;
      return json({ data }, 201);
    }


    const incidentGetMatch = path.match(/^\/incidents\/([^/]+)$/);
    if (incidentGetMatch && req.method === 'GET') {
      const id = requireUuid(incidentGetMatch[1]);
      const { data, error } = await supabase.from('incidents').select('id,code,institution_id,reporter_id,category,status,priority,title,description,source_channel,delivery_method,location_label,location_source,location_accuracy_m,location_context,ai_confidence,ai_fp_code,auto_pushed,via_relay,reported_at,acknowledged_at,resolved_at,closed_at,created_at,updated_at').eq('id', id).maybeSingle();
      if (error) throw error;
      // RLS hides another institution's incident, so a missing row is the tenant-isolation
      // signal too -- return the same 404 rather than leaking PostgREST's `.single()` error.
      if (!data) return json({ error: 'Incident not found' }, 404);
      return json({ data });
    }

    if (path === '/contacts' && req.method === 'GET') {
      const { data, error } = await supabase.from('emergency_contacts').select('id,name,phone,relationship,notify_on_incident,created_at').eq('user_id', user.id).order('created_at');
      if (error) throw error;
      return json({ data: data ?? [] });
    }
    if (path === '/contacts' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const name = textValue(body.name, 120); const phone = textValue(body.phone, 40);
      if (!name || !phone) return json({ error: 'Contact name and phone are required' }, 422);
      const { data, error } = await supabase.from('emergency_contacts').insert({ user_id:user.id,name,phone,relationship:textValue(body.relationship,80),notify_on_incident:body.notify_on_incident !== false }).select('id,name,phone,relationship,notify_on_incident,created_at').single();
      if (error) throw error;
      return json({ data }, 201);
    }
    const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
    if (contactMatch && req.method === 'PATCH') {
      const id = requireUuid(contactMatch[1]); const body = await readJsonLimited(req);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = textValue(body.name,120);
      if (body.phone !== undefined) patch.phone = textValue(body.phone,40);
      if (body.relationship !== undefined) patch.relationship = textValue(body.relationship,80);
      if (body.notify_on_incident !== undefined) patch.notify_on_incident = Boolean(body.notify_on_incident);
      const { data, error } = await supabase.from('emergency_contacts').update(patch).eq('id',id).eq('user_id',user.id).select('id,name,phone,relationship,notify_on_incident,created_at').single();
      if (error) throw error;
      return json({ data });
    }
    if (contactMatch && req.method === 'DELETE') {
      const id = requireUuid(contactMatch[1]);
      const { error } = await supabase.from('emergency_contacts').delete().eq('id',id).eq('user_id',user.id);
      if (error) throw error;
      return json({ ok:true });
    }

    const statusMatch = path.match(/^\/incidents\/([^/]+)\/status$/);
    if (statusMatch && req.method === 'PATCH') {
      const id = requireUuid(statusMatch[1]);
      const body = await readJsonLimited(req);
      const status = textValue(body.status, 30)?.toLowerCase();
      if (!status || !allowedStatuses.has(status)) return json({ error: 'Invalid incident status' }, 422);
      const verificationState = body.verification_state == null ? null : textValue(body.verification_state, 30);
      const { data, error } = await supabase.rpc('transition_incident', { p_incident_id: id, p_to: status, p_verification_state: verificationState });
      if (error) throw error;
      return json({ data });
    }

    const assignMatch = path.match(/^\/incidents\/([^/]+)\/assign$/);
    if (assignMatch && req.method === 'POST') {
      const id = requireUuid(assignMatch[1]);
      const body = await readJsonLimited(req);
      const responderId = requireUuid(textValue(body.responder_id, 64));
      const { data, error } = await supabase.rpc('assign_incident', { p_incident_id: id, p_responder_id: responderId });
      if (error) throw error;
      return json({ data }, 201);
    }

    if (path === '/relay/packets' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const svc = requireService();
      const verdict = await verifyRelayBody(body, {
        actorInstitutionId: profile.institution_id ?? null,
        dedup: {
          // Gateway dedup: packet_key + packet_hash (multi-path safe: BLE/Wi-Fi/PWA).
          // A single atomic upsert; a read-then-write lost receive_count updates and raised
          // duplicate-key errors when the same packet arrived over several transports at once.
          async record(packetKey, packetHash, institutionId) {
            const { error } = await svc.rpc('record_relay_ingest_dedup', {
              p_packet_key: packetKey,
              p_packet_hash: packetHash,
              p_institution_id: institutionId,
            });
            if (error) throw error;
          },
        },
      });
      if (!verdict.ok) return json({ error: verdict.error }, verdict.status);
      const { data, error } = await requireService().rpc('ingest_relay_packet_service', { p_packet: verdict.packet, p_actor_id: user.id });
      if (error) throw error;
      return json({ data }, 201);
    }


    if (path === '/members' && req.method === 'GET') {
      if (!profile.institution_id) return json({ data: [] });
      const { data, error } = await supabase.rpc('list_institution_member_directory');
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    if (path === '/responders' && req.method === 'GET') {
      if (!profile.institution_id && !['operator', 'super-admin'].includes(profile.role)) return json({ data: [] });
      const { data, error } = await supabase.rpc('list_responder_directory');
      if (error) throw error;
      return json({ data: data ?? [] });
    }
    if (path === '/responders' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const userId = requireUuid(textValue(body.user_id,64));
      const responderType = textValue(body.responder_type,40) || 'staff';
      const { data, error } = await supabase.rpc('add_responder', { p_user_id:userId, p_responder_type:responderType });
      if (error) throw error;
      return json({ data },201);
    }
    if (path === '/responders/me/status' && req.method === 'PATCH') {
      const body = await readJsonLimited(req);
      const status = textValue(body.status,20);
      const { data, error } = await supabase.rpc('set_my_responder_status', { p_status:status });
      if (error) throw error;
      return json({ data });
    }

    if (path === '/tasks' && req.method === 'GET') {
      const { data: responderRows, error: responderError } = await supabase.from('responders').select('id').eq('user_id', user.id);
      if (responderError) throw responderError;
      const responderIds = (responderRows ?? []).map((r: { id: string }) => r.id);
      if (!responderIds.length) return json({ data: [] });
      const { data: assignments, error: assignmentError } = await supabase.from('incident_assignments').select('id,incident_id,responder_id,status,assigned_at,accepted_at,completed_at').in('responder_id', responderIds).order('assigned_at', { ascending: false }).limit(100);
      if (assignmentError) throw assignmentError;
      const incidentIds = [...new Set((assignments ?? []).map((a: { incident_id: string }) => a.incident_id))];
      const { data: incidents, error: incidentError } = incidentIds.length ? await supabase.from('incidents').select('id,code,category,status,title,location_label,ai_confidence,ai_fp_code,source_channel,via_relay').in('id', incidentIds) : { data: [], error: null };
      if (incidentError) throw incidentError;
      const incidentMap = new Map((incidents ?? []).map((i: any) => [i.id, i]));
      return json({ data: (assignments ?? []).map((a: any) => ({ ...a, incident: incidentMap.get(a.incident_id) ?? null })) });
    }

    const taskStatusMatch = path.match(/^\/tasks\/([^/]+)\/status$/);
    if (taskStatusMatch && req.method === 'PATCH') {
      const id = requireUuid(taskStatusMatch[1]);
      const body = await readJsonLimited(req);
      const status = textValue(body.status, 30);
      if (!status) return json({ error: 'Task status is required' }, 422);
      const { data, error } = await supabase.rpc('transition_assignment', { p_assignment_id: id, p_status: status });
      if (error) throw error;
      return json({ data });
    }

    if (path === '/institutions' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      const { data, error } = await supabase.from('institutions').select('id,name,category,city,address,timezone,created_at,updated_at').order('created_at', { ascending: false });
      if (error) throw error;
      return json({ data: data ?? [] });
    }


    if (path === '/institution/billing/bmoni' && req.method === 'GET') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const [{ data: account, error: accountError }, { data: subscription, error: subscriptionError }, { data: payments, error: paymentsError }] = await Promise.all([
        supabase.from('bmoni_institution_accounts').select('id,institution_id,bmoni_user_id,smart_wallet_id,wallet_address,currency,onboarding_status,bvn_verified,ngn_virtual_account_ready,created_at,updated_at').eq('institution_id', profile.institution_id).maybeSingle(),
        supabase.from('subscriptions').select('*').eq('institution_id', profile.institution_id).order('created_at', { ascending: false }).limit(1),
        supabase.from('payments').select('*').eq('institution_id', profile.institution_id).order('created_at', { ascending: false }).limit(20),
      ]);
      if (accountError || subscriptionError || paymentsError) throw accountError || subscriptionError || paymentsError;
      return json({
        data: {
          provider: 'BMONI Embedded',
          configured: bmoniConfigured(),
          payment_required_for: 'institution',
          end_users_pay: false,
          account: account ?? null,
          subscription: subscription?.[0] ?? null,
          payments: payments ?? [],
          configured_amount_cngn: Deno.env.get('REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN')?.trim() || DEFAULT_SUBSCRIPTION_AMOUNT_CNGN,
          treasury_address_configured: Boolean(Deno.env.get('REACH_BMONI_TREASURY_ADDRESS')?.trim() || account?.wallet_address),
        },
      });
    }

    if (path === '/institution/billing/bmoni/user' && req.method === 'POST') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      if (!bmoniConfigured()) return json({ error: 'BMONI is not configured on the server' }, 503);
      const body = await readJsonLimited(req);
      const firstName = textValue(body.first_name, 80);
      const lastName = textValue(body.last_name, 80);
      const email = textValue(body.email, 254)?.toLowerCase();
      const phoneNumber = normalizePhone(body.phone_number);
      if (!firstName || !lastName || !email || !email.includes('@')) return json({ error: 'Authorized payer first name, last name and email are required' }, 422);
      if (!phoneNumber) return json({ error: 'Enter a valid phone number in E.164 format (for example +2348012345678).' }, 422);
      const { data: existingAccount } = await supabase.from('bmoni_institution_accounts').select('id,bmoni_user_id,onboarding_status').eq('institution_id', profile.institution_id).maybeSingle();
      if (existingAccount?.bmoni_user_id) return json({ data: existingAccount });
      let result: any;
      try { result = await bmoni.createUser({ firstName, lastName, email, phoneNumber }); }
      catch (error: any) {
        if (error?.status === 409 && error?.body) result = error.body;
        else throw error;
      }
      // BMONI returns `{ user: { id, bmoniUserId } }`; only `bmoniUserId` is accepted by
      // user-scoped paths (the wrapper's `id` 404s). A 409 carries no record, and an
      // account with no stored id has nothing to read back, so recover by email lookup.
      let bmoniUserId = bmoniUserIdFrom(result);
      if (!bmoniUserId && email) bmoniUserId = await findBmoniUserIdByEmail(email);
      if (!bmoniUserId) return json({ error: 'BMONI user already exists, but the existing user id was not returned. Resolve the account through BMONI support/admin tooling.' }, 409);
      const { data, error } = await requireService().from('bmoni_institution_accounts').upsert({
        institution_id: profile.institution_id,
        bmoni_user_id: String(bmoniUserId),
        onboarding_status: 'user_created',
        metadata: { payer_email: email, payer_phone: phoneNumber },
      }, { onConflict: 'institution_id' }).select().single();
      if (error) throw error;
      return json({ data: { id: data.id, bmoni_user_id: data.bmoni_user_id, onboarding_status: data.onboarding_status } }, 201);
    }

    if (path === '/institution/billing/bmoni/owner-proof-challenge' && req.method === 'POST') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const body = await readJsonLimited(req);
      const walletAddress = textValue(body.wallet_address, 120);
      if (!walletAddress) return json({ error: 'Wallet address is required' }, 422);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,metadata').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id) return json({ error: 'Create the institution BMONI payer account first' }, 409);
      const service = requireService();
      const challenge = await withBmoniUserId(account,
        (id) => bmoni.ownerProofChallenge(id, { currency: 'CNGN', userOwnerAddress: walletAddress }),
        (healed) => service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {}));
      return json({ data: challenge });
    }

    if (path === '/institution/billing/bmoni/wallet' && req.method === 'POST') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const body = await readJsonLimited(req);
      const walletAddress = textValue(body.wallet_address, 120);
      const challengeId = textValue(body.owner_proof_challenge_id, 200);
      const signature = textValue(body.owner_proof_signature, 300);
      if (!walletAddress || !challengeId || !signature) return json({ error: 'wallet_address, owner_proof_challenge_id and owner_proof_signature are required' }, 422);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,metadata').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id) return json({ error: 'Create the institution BMONI payer account first' }, 409);
      const service = requireService();
      const result = await withBmoniUserId(account,
        (id) => bmoni.createManagedWallet(id, { currency: 'CNGN', userOwnerAddress: walletAddress, ownerProofChallengeId: challengeId, ownerProofSignature: signature }),
        (healed) => service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {}));
      const walletId = result?.smartWalletId || result?.id || result?.smartWallet?.id;
      const returnedAddress = result?.walletAddress || result?.address || result?.smartWallet?.address || walletAddress;
      if (!walletId) return json({ error: 'BMONI did not return a smart wallet id' }, 502);
      const { data, error: updateError } = await service.from('bmoni_institution_accounts').update({ smart_wallet_id: String(walletId), wallet_address: returnedAddress, onboarding_status: 'wallet_created' }).eq('institution_id', profile.institution_id).select().single();
      if (updateError) throw updateError;
      return json({ data: { smart_wallet_id: data.smart_wallet_id, wallet_address: data.wallet_address, onboarding_status: data.onboarding_status } }, 201);
    }


    if (path === '/institution/billing/bmoni/kyc' && req.method === 'PATCH') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,metadata').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id) return json({ error: 'Create the institution BMONI payer account first' }, 409);
      const body = await readJsonLimited(req);
      const personalInfo = body.personalInfo;
      // BMONI rejects `addressDetails` outright ("property addressDetails should not exist")
      // and expects a single `address` object with streetLine1/city/state/postalCode/
      // countryCode -- not street/city/countryCode. Accept either client name, send `address`.
      const address = body.address ?? body.addressDetails;
      if (!personalInfo || !address) return json({ error: 'personalInfo and address are required' }, 422);
      const service = requireService();
      const kycResult = await withBmoniUserId(account,
        (id) => bmoni.updateKyc(id, { personalInfo, address, ...(body.occupationCode ? { occupationCode: body.occupationCode } : {}) }),
        (healed) => service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {}));
      return json({ data: kycResult });
    }

    if (path === '/institution/billing/bmoni/start-nigeria' && req.method === 'POST') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const body = await readJsonLimited(req);
      const bvn = textValue(body.bvn, 20);
      if (!bvn || !/^\d{11}$/.test(bvn)) return json({ error: 'A valid 11-digit BVN is required' }, 422);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,metadata,wallet_address').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id || !account.wallet_address) return json({ error: 'Create the BMONI wallet before starting Nigeria onboarding' }, 409);
      const service = requireService();
      const result = await withBmoniUserId(account,
        (id) => bmoni.startNigeria(id, { bvn, ngnWalletAddress: account.wallet_address, ngnWalletIndex: Number(body.ngn_wallet_index ?? 0) }),
        (healed) => service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {}));
      const { error: updateError } = await service.from('bmoni_institution_accounts').update({ onboarding_status: 'ngn_started', bvn_verified: true }).eq('institution_id', profile.institution_id);
      if (updateError) throw updateError;
      return json({ data: result });
    }

    if (path === '/institution/billing/bmoni/status' && req.method === 'GET') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,metadata').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id) return json({ error: 'BMONI payer account is not configured' }, 409);
      const service = requireService();
      const result = await withBmoniUserId(account, (id) => bmoni.onboardingStatus(id), (healed) =>
        service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {}));
      return json({ data: result });
    }

    if (path === '/institution/billing/bmoni/deposit-account' && req.method === 'GET') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,metadata').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id) return json({ error: 'BMONI payer account is not configured' }, 409);
      const service = requireService();
      const heal = (healed: string) => service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {});
      const result = await withBmoniUserId(account, (id) => bmoni.depositAccount(id), heal);
      await service.from('bmoni_institution_accounts').update({ ngn_virtual_account_ready: true, onboarding_status: 'active' }).eq('institution_id', profile.institution_id);
      return json({ data: result });
    }

    if (path === '/institution/billing/bmoni/payment/proposal' && req.method === 'POST') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const body = await readJsonLimited(req);
      // Institutional price: server-controlled. REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN overrides
      // it; the default keeps the sandbox/demo walkthrough working with no extra configuration.
      // A client can never supply either the amount or the destination.
      const amount = Deno.env.get('REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN')?.trim() || DEFAULT_SUBSCRIPTION_AMOUNT_CNGN;
      const configuredTreasury = Deno.env.get('REACH_BMONI_TREASURY_ADDRESS')?.trim() || '';
      const idempotencyKey = textValue(req.headers.get('x-idempotency-key') || body.idempotency_key, 160);
      if (!idempotencyKey) return json({ error: 'x-idempotency-key is required for payment operations' }, 422);
      if (!amount || !/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) return json({ error: 'A valid institutional subscription amount is required' }, 422);
      const { data: account, error } = await supabase.from('bmoni_institution_accounts').select('bmoni_user_id,smart_wallet_id,wallet_address,metadata').eq('institution_id', profile.institution_id).single();
      if (error || !account?.bmoni_user_id || !account.smart_wallet_id) return json({ error: 'Complete BMONI user and CNGN wallet setup before paying' }, 409);
      // Destination of the subscription transfer. Prefer the configured REACH treasury wallet;
      // when no separate treasury exists (demo/sandbox) fall back to the institution's own CNGN
      // smart wallet, which makes the proposal a self-transfer BMONI still signs and settles.
      // Either way the destination is server-derived -- a client can never name it, nor the amount.
      const treasuryAddress = configuredTreasury || String(account.wallet_address ?? '').trim();
      if (!treasuryAddress) return json({ error: 'REACH BMONI treasury wallet is not configured' }, 503);
      const service = requireService();
      // Resolve (and heal) the BMONI user id before writing any local rows, so the id recorded
      // on bmoni_transactions — reused later by payment/sign — matches the provider calls here.
      let bmoniUserId = String(account.bmoni_user_id);
      try { await bmoni.onboardingStatus(bmoniUserId); }
      catch (probeError: any) {
        const payerEmail = account?.metadata?.payer_email;
        if (probeError?.status === 404 && payerEmail) {
          const healed = await findBmoniUserIdByEmail(payerEmail);
          if (healed && healed !== bmoniUserId) {
            await service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id);
            bmoniUserId = healed;
          }
        }
      }
      const { data: existing } = await service.from('bmoni_transactions').select('*').eq('institution_id', profile.institution_id).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existing) return json({ data: existing });
      const { data: subscription } = await supabase.from('subscriptions').select('id').eq('institution_id', profile.institution_id).order('created_at', { ascending: false }).limit(1).maybeSingle();

      // Create the local financial intent BEFORE touching BMONI. The unique
      // (institution_id,idempotency_key) constraint is the concurrency guard.
      const intentInsert = await service.from('bmoni_transactions').insert({ institution_id: profile.institution_id, subscription_id: subscription?.id ?? null, bmoni_user_id: bmoniUserId, smart_wallet_id: account.smart_wallet_id, idempotency_key: idempotencyKey, amount: Number(amount), currency: 'CNGN', status: 'initiated', description: textValue(body.description, 240) || 'REACH institutional subscription' }).select().single();
      if (intentInsert.error) {
        const { data: retryExisting } = await service.from('bmoni_transactions').select('*').eq('institution_id', profile.institution_id).eq('idempotency_key', idempotencyKey).maybeSingle();
        if (retryExisting) return json({ data: retryExisting });
        throw intentInsert.error;
      }
      const paymentInsert = await service.from('payments').insert({ institution_id: profile.institution_id, subscription_id: subscription?.id ?? null, amount: Number(amount), currency: 'CNGN', status: 'pending', provider: 'BMONI Embedded' }).select().single();
      if (paymentInsert.error) {
        await service.from('bmoni_transactions').update({ status: 'failed', failure_reason: String(paymentInsert.error.message || 'Unable to create payment record').slice(0,500) }).eq('id', intentInsert.data.id);
        throw paymentInsert.error;
      }
      const attachPayment = await service.from('bmoni_transactions').update({ payment_id: paymentInsert.data.id }).eq('id', intentInsert.data.id);
      if (attachPayment.error) throw attachPayment.error;

      try {
        const proposal = await bmoni.createProposal(bmoniUserId, account.smart_wallet_id, { proposal: { type: 'TRANSFER', toAddress: treasuryAddress, amount, currency: 'CNGN', description: textValue(body.description, 240) || 'REACH institutional subscription' } });
        const proposalId = proposal?.proposalId || proposal?.id || proposal?.proposal?.id;
        if (!proposalId) throw new Error('BMONI did not return a proposal id');
        await bmoni.approveProposal(bmoniUserId, String(proposalId));
        const signPayload = await bmoni.proposalSignPayload(bmoniUserId, String(proposalId));
        // BMONI returns the digest as signingPayloadHash; hashToSign/payload are documented
        // names it does not emit. Missing all three silently stored sign_payload as null.
        const update = await service.from('bmoni_transactions').update({ proposal_id: String(proposalId), status: 'pending', sign_payload: signPayload?.signingPayloadHash || signPayload?.hashToSign || signPayload?.payload || null, raw_response: { proposal, signPayload } }).eq('id', intentInsert.data.id).select().single();
        if (update.error) throw update.error;
        await service.from('payments').update({ provider_reference: String(proposalId) }).eq('id', paymentInsert.data.id);
        return json({ data: { transaction: update.data, proposal_id: String(proposalId), sign_payload: signPayload, signing: 'signTransactionHash', note: 'The raw 32-byte hash must be signed on the institution device using the BMONI Embedded SDK. Do not use EIP-191 for this step.' } }, 201);
      } catch (providerError) {
        await service.from('bmoni_transactions').update({ status: 'failed', failure_reason: String(providerError instanceof Error ? providerError.message : (providerError as any)?.message ?? providerError).slice(0,500) }).eq('id', intentInsert.data.id);
        await service.from('payments').update({ status: 'failed' }).eq('id', paymentInsert.data.id);
        throw providerError;
      }
    }

    if (path === '/institution/billing/bmoni/payment/sign' && req.method === 'POST') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const body = await readJsonLimited(req);
      const proposalId = textValue(body.proposal_id, 200);
      const signature = textValue(body.signature, 300);
      if (!proposalId || !signature) return json({ error: 'proposal_id and signature are required' }, 422);
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return json({ error: 'Signature must be a 65-byte 0x-prefixed hexadecimal signature from the BMONI SDK' }, 422);
      const { data: tx, error } = await supabase.from('bmoni_transactions').select('*').eq('institution_id', profile.institution_id).eq('proposal_id', proposalId).single();
      if (error || !tx) return json({ error: 'BMONI payment proposal not found' }, 404);
      // The proposal route heals the stored id, but a transaction created before that fix can
      // still carry a stale/internal id, which 404s on the provider. Reuse the same heal here
      // (via the account row, keyed on the institution) so signing cannot fail on a stored id
      // that the proposal step would have repaired.
      const { data: account } = await supabase.from('bmoni_institution_accounts')
        .select('bmoni_user_id,metadata').eq('institution_id', profile.institution_id).maybeSingle();
      const service = requireService();
      const heal = (healed: string) => service.from('bmoni_institution_accounts').update({ bmoni_user_id: healed }).eq('institution_id', profile.institution_id).then(() => {});
      const payerEmail = account?.metadata?.payer_email;
      let signUserId = String(tx.bmoni_user_id);
      if (payerEmail && signUserId !== String(account?.bmoni_user_id ?? '')) {
        try { await bmoni.onboardingStatus(signUserId); }
        catch (probeError: any) {
          if (probeError?.status === 404) {
            const healed = await findBmoniUserIdByEmail(payerEmail);
            if (healed && healed !== signUserId) {
              signUserId = healed;
              await service.from('bmoni_transactions').update({ bmoni_user_id: healed }).eq('id', tx.id);
              if (account?.bmoni_user_id) await heal(healed);
            }
          }
        }
      }
      const result = await bmoni.signProposal(signUserId, proposalId, signature);
      await service.from('bmoni_transactions').update({ status: 'pending', raw_response: { ...tx.raw_response, signResult: result } }).eq('id', tx.id);
      return json({ data: result });
    }

    const txMatch = path.match(/^\/institution\/billing\/bmoni\/payment\/([^/]+)$/);
    if (txMatch && req.method === 'GET') {
      if (profile.role !== 'institution' || !profile.institution_id) return json({ error: 'Institution administrator role required' }, 403);
      const id = requireUuid(txMatch[1]);
      const { data, error } = await supabase.from('bmoni_transactions').select('id,institution_id,subscription_id,proposal_id,bmoni_transaction_id,amount,currency,status,description,failure_reason,created_at,updated_at').eq('institution_id', profile.institution_id).eq('id', id).single();
      if (error || !data) return json({ error: 'Payment transaction not found' }, 404);
      return json({ data });
    }

    if (path === '/institution/summary' && req.method === 'GET') {
      if (!profile.institution_id) return json({ error: 'Institution is not configured' }, 409);
      const institutionId = profile.institution_id;
      const [{ data: institution, error: institutionError }, { data: members, error: membersError }, { data: subscription, error: subscriptionError }, { data: payments, error: paymentsError }] = await Promise.all([
        supabase.from('institutions').select('*').eq('id', institutionId).single(),
        supabase.from('institution_members').select('user_id,membership_role,status').eq('institution_id', institutionId),
        supabase.from('subscriptions').select('*').eq('institution_id', institutionId).order('created_at', { ascending: false }).limit(1),
        supabase.from('payments').select('*').eq('institution_id', institutionId).order('created_at', { ascending: false }).limit(20),
      ]);
      if (institutionError) throw institutionError;
      if (membersError || subscriptionError || paymentsError) throw membersError || subscriptionError || paymentsError;
      return json({ data: { institution, members: members ?? [], subscription: subscription?.[0] ?? null, payments: payments ?? [] } });
    }

    if (path === '/operator/summary' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      const [{ count: institutionCount }, { count: incidentCount }, { count: activeCount }, { count: relayCount }, { data: recent }] = await Promise.all([
        supabase.from('institutions').select('id', { count: 'exact', head: true }),
        supabase.from('incidents').select('id', { count: 'exact', head: true }),
        supabase.from('incidents').select('id', { count: 'exact', head: true }).neq('status','resolved').neq('status','closed').neq('status','cancelled'),
        supabase.from('relay_packets').select('id', { count: 'exact', head: true }).eq('status', 'delivered'),
        supabase.from('incidents').select('id,code,status,category,priority,reported_at').order('reported_at', { ascending: false }).limit(10),
      ]);
      return json({ data: { institutionCount: institutionCount ?? 0, incidentCount: incidentCount ?? 0, activeCount: activeCount ?? 0, relayDelivered: relayCount ?? 0, recent: recent ?? [] } });
    }

    if (path === '/ai/assess' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const incidentId = requireUuid(textValue(body.incident_id, 64));
      // Authorize the incident BEFORE calling any external AI provider.
      const { data: incidentForAi, error: incidentForAiError } = await supabase.from('incidents').select('id,category,institution_id,reporter_id,description,location_label,location_accuracy_m,via_relay,reported_at').eq('id', incidentId).single();
      if (incidentForAiError || !incidentForAi) return json({ error: 'Incident not found' }, 404);
      if (profile.institution_id && incidentForAi.institution_id !== profile.institution_id && !['operator','super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      if (!profile.institution_id && !['operator','super-admin'].includes(profile.role) && incidentForAi.reporter_id !== user.id) return json({ error: 'Not permitted' }, 403);

      const reportedCategory = textValue(body.reported_category, 30) ?? null;
      const description = textValue(body.description, 4000) ?? incidentForAi.description ?? null;

      // Evidence supplied by the caller wins; otherwise derive it from the incident so the engine
      // fuses a real set instead of abstaining on an empty one. Only the *derived* rows are replaced,
      // so a citizen's captured photo survives an assessment; the check for "already derived" looks
      // at those rows specifically, not at captured evidence. Derivation needs service-role rights
      // (see ingest_incident_evidence_service), and a failure there must not fail the assessment.
      let evidence = Array.isArray(body.evidence) ? body.evidence.slice(0, 50) : [];
      if (evidence.length === 0) {
        try {
          const service = requireService();
          const { count: derivedCount } = await supabase.from('incident_evidence')
            .select('id', { count: 'exact', head: true })
            .eq('incident_id', incidentId)
            .eq('metadata->>derived', 'true');
          if (!derivedCount) {
            const derived = deriveEvidenceFromIncident(incidentForAi, description, reportedCategory);
            if (derived.length) {
              const { error: ingestError } = await service.rpc('ingest_incident_evidence_service', { p_incident_id: incidentId, p_evidence: derived });
              if (ingestError) throw ingestError;
            }
          }
          const { data: stored } = await supabase.from('incident_evidence')
            .select('evidence_type,confidence,metadata,source,storage_path')
            .eq('incident_id', incidentId);
          evidence = (stored ?? []).map((row: any) => ({
            kind: row.evidence_type,
            confidence: Number(row.confidence ?? 0) / 100,
            quality: Number(row.metadata?.quality ?? 1),
            timestamp: incidentForAi.reported_at,
            source: row.source ?? undefined,
            // Captured media is real, independent evidence; a stored object path proves an upload.
            storage_path: row.storage_path ?? undefined,
            category: allowedCategories.has(reportedCategory ?? incidentForAi.category) ? (reportedCategory ?? incidentForAi.category) : undefined,
          }));
        } catch { /* assessment proceeds without persisted evidence */ }
      }

      const modelResult = await modelAssist({ category: reportedCategory ?? undefined, description: description ?? undefined, evidence });
      const result = assessEvidence({
        reportedCategory: reportedCategory ?? undefined,
        userConfirmed: typeof body.user_confirmed === 'boolean' ? body.user_confirmed : undefined,
        evidence,
        locationAccuracyM: body.location_accuracy_m == null ? undefined : numberValue(body.location_accuracy_m, 0, 100000) ?? undefined,
        corroboratingReports: Number.isFinite(Number(body.corroborating_reports)) ? Math.max(0, Math.min(5, Number(body.corroborating_reports))) : 0,
        modelAssist: modelResult ? { category: modelResult.category, confidence: modelResult.confidence / 100 } : null,
      });
      const finalResult = modelResult ? { ...result, explanation: `${result.explanation} Model rationale: ${modelResult.rationale}`, model_used: true, model_category: modelResult.category, model_confidence: modelResult.confidence, model_evidence_labels: modelResult.evidence_labels ?? [] } : { ...result, model_used: false };

      // Record why a second opinion was missing. The provider's in-memory state is not queryable and
      // /system/health reports only env configuration, so without this an operator cannot tell
      // "the model declined" from "the model was never called".
      try {
        const service = requireService();
        const kind = modelResult ? null : aiLastFailureKind();
        await service.from('ai_provider_events').insert({
          institution_id: incidentForAi.institution_id ?? profile.institution_id ?? null,
          incident_id: incidentId,
          outcome: modelResult ? 'ok' : 'failure',
          model: modelResult?.model ?? Deno.env.get('REACH_AI_MODEL') ?? null,
          failure_kind: kind,
          detail: modelResult ? null : (aiLastFailure() || null),
          latency_ms: modelResult?.latency_ms ?? null,
        });
      } catch { /* telemetry must never break the assessment */ }

      const { data, error } = await supabase.rpc('store_ai_assessment_for_incident', {
        p_incident_id: incidentId, p_model_name: finalResult.model_name, p_category: finalResult.category,
        p_confidence: finalResult.confidence, p_fp_code: finalResult.fp_code, p_evidence_ids: [],
        p_explanation: finalResult.explanation, p_decision: finalResult.decision,
        p_metadata: { evidence_strength: finalResult.evidence_strength, margin: finalResult.margin, abstain: finalResult.abstain, reasons: finalResult.reasons, decision_basis: finalResult.decision_basis, model_used: finalResult.model_used, model_agreement: finalResult.model_agreement, model_category: finalResult.model_category ?? null, model_confidence: finalResult.model_confidence ?? null, model_evidence_labels: finalResult.model_evidence_labels ?? [], evidence_count: evidence.length, model_failure_kind: modelResult ? null : aiLastFailureKind(), urgency: finalResult.urgency }
      });
      if (error) throw error;
      return json({ data: { assessment: data, ...finalResult } }, 201);
    }

    if (path === '/ai/assessments' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      // metadata carries the fusion signals (model_agreement, model_used, model_category,
      // model_confidence, blockers) that make the second opinion auditable in the operator view.
      const { data, error } = await supabase.from('ai_assessments').select('id,incident_id,model_name,category,confidence,fp_code,explanation,decision,metadata,created_at').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    if (path === '/ai/provider-events' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      // Why a second opinion was missing: 'ok' vs a failure kind, so "the model declined" is
      // distinguishable from "the model was never called".
      const { data, error } = await supabase.from('ai_provider_events').select('id,incident_id,outcome,model,failure_kind,detail,latency_ms,created_at').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    // Capture path for the strong evidence kinds (image/audio/sensor/motion). The client uploads the
    // object to Storage first, then registers it here; attach_incident_evidence re-checks ownership
    // of the path and derives the fusion confidence server-side.
    if (path === '/evidence' && req.method === 'POST') {
      const body = await readJsonLimited(req);
      const incidentId = requireUuid(textValue(body.incident_id, 64));
      const kind = textValue(body.kind, 20);
      // Mirrors the RPC's allowed set. sensor/motion are deliberately absent: they describe device
      // integrations a citizen client cannot perform, and stay reachable only via the derived path.
      const captureKinds = ['image', 'audio', 'video', 'text', 'location'];
      if (!kind || !captureKinds.includes(kind)) return json({ error: 'Unsupported evidence kind' }, 400);
      const storagePath = textValue(body.storage_path, 512);
      // metadata is untrusted client input; bound it and keep it an object so it cannot replace the
      // `captured` marker the RPC merges in.
      const rawMetadata = body.metadata;
      const metadata = rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
        ? Object.fromEntries(Object.entries(rawMetadata as Record<string, unknown>).slice(0, 12).map(([k, v]) => [String(k).slice(0, 40), typeof v === 'string' ? v.slice(0, 200) : v]))
        : {};
      const { data, error } = await supabase.rpc('attach_incident_evidence', {
        p_incident_id: incidentId,
        p_kind: kind,
        p_storage_path: storagePath,
        p_content_hash: textValue(body.content_hash, 128),
        p_metadata: metadata,
      });
      if (error) {
        // The RPC raises for authorization and validation; surface it as a 4xx, not a 500.
        return json({ error: error.message }, 403);
      }
      return json({ data }, 201);
    }

    if (path === '/evidence' && req.method === 'GET') {
      const incidentId = requireUuid(textValue(url.searchParams.get('incident_id'), 64));
      const { data: incidentForEvidence, error: incidentError } = await supabase.from('incidents').select('id,reporter_id,institution_id').eq('id', incidentId).single();
      if (incidentError || !incidentForEvidence) return json({ error: 'Incident not found' }, 404);
      const allowed = incidentForEvidence.reporter_id === user.id
        || (profile.institution_id && incidentForEvidence.institution_id === profile.institution_id)
        || ['operator', 'super-admin'].includes(profile.role);
      if (!allowed) return json({ error: 'Not permitted' }, 403);
      const { data, error } = await supabase.from('incident_evidence')
        .select('id,incident_id,evidence_type,confidence,storage_path,content_hash,metadata,created_at')
        .eq('incident_id', incidentId).order('created_at', { ascending: false });
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    if (path === '/relay/health' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      const [{ count: queued }, { count: received }, { count: forwarded }, { count: delivered }, { count: expired }] = await Promise.all([
        supabase.from('relay_packets').select('id', { count: 'exact', head: true }).eq('status', 'queued'),
        supabase.from('relay_packets').select('id', { count: 'exact', head: true }).eq('status', 'received'),
        supabase.from('relay_packets').select('id', { count: 'exact', head: true }).eq('status', 'forwarded'),
        supabase.from('relay_packets').select('id', { count: 'exact', head: true }).eq('status', 'delivered'),
        supabase.from('relay_packets').select('id', { count: 'exact', head: true }).eq('status', 'expired'),
      ]);
      return json({ data: { queued: queued ?? 0, received: received ?? 0, forwarded: forwarded ?? 0, delivered: delivered ?? 0, expired: expired ?? 0 } });
    }

    if (path === '/system/health' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      const started = Date.now();
      const [dbProbe, incidentProbe, relayProbe] = await Promise.all([
        supabase.from('profiles').select('id', { head: true, count: 'exact' }),
        supabase.from('incidents').select('id', { head: true, count: 'exact' }),
        supabase.from('relay_packets').select('id', { head: true, count: 'exact' }),
      ]);
      const aiConfigured = Boolean(Deno.env.get('REACH_AI_ENDPOINT') && Deno.env.get('REACH_AI_API_KEY') && Deno.env.get('REACH_AI_MODEL'));
      const circuit = aiCircuitSnapshot();
      // 'Configured' alone hid a dead provider: a provider whose breaker is open is unreachable for
      // now, and one that answered with unusable content last time is degraded. Report that.
      const aiStatus = !aiConfigured ? 'Not configured' : circuit.open ? 'Circuit open' : aiLastFailureKind() ? 'Degraded' : 'Healthy';
      const checks = [
        { service: 'REACH API', status: 'Healthy', latency_ms: Date.now() - started },
        { service: 'PostgreSQL / Supabase', status: dbProbe.error ? 'Unhealthy' : 'Healthy', error: dbProbe.error?.message ?? null },
        { service: 'Incident store', status: incidentProbe.error ? 'Unhealthy' : 'Healthy', error: incidentProbe.error?.message ?? null },
        { service: 'Relay store', status: relayProbe.error ? 'Unhealthy' : 'Healthy', error: relayProbe.error?.message ?? null },
        { service: 'BMONI configuration', status: bmoniConfigured() ? 'Configured' : 'Not configured' },
        { service: 'AI provider', status: aiStatus, configured: aiConfigured, consecutive_failures: circuit.failures, last_failure_kind: aiLastFailureKind(), last_failure: aiLastFailure() || null },
      ];
      return json({ data: checks, checked_at: new Date().toISOString(), overall: checks.some((c) => c.status === 'Unhealthy' || c.status === 'Circuit open') ? 'degraded' : 'healthy' });
    }

    
    // Record delivery attempt idempotently (channel + recipient + notification)
    if (path === '/notifications/deliveries' && req.method === 'POST') {
      if (!['operator','super-admin','security-desk','institution'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      const body = await readJsonLimited(req);
      const notificationId = textValue(body.notification_id, 36);
      const channel = textValue(body.channel, 40) || 'push';
      const recipient = textValue(body.recipient, 200);
      if (!notificationId || !recipient) return json({ error: 'notification_id and recipient are required' }, 422);
      const service = requireService();
      const { data: existing } = await service.from('notification_deliveries').select('*').eq('notification_id', notificationId).eq('channel', channel).eq('recipient', recipient).maybeSingle();
      if (existing) return json({ data: existing, duplicate: true });
      const { data, error } = await service.from('notification_deliveries').insert({
        notification_id: notificationId,
        channel,
        recipient,
        status: 'queued',
        provider_message_id: textValue(body.provider_message_id, 200),
      }).select().single();
      if (error) {
        if (String(error.message||'').toLowerCase().includes('duplicate')) {
          const again = await service.from('notification_deliveries').select('*').eq('notification_id', notificationId).eq('channel', channel).eq('recipient', recipient).maybeSingle();
          return json({ data: again.data, duplicate: true });
        }
        throw error;
      }
      return json({ data }, 201);
    }

if (path === '/notifications' && req.method === 'GET') {
      const { data, error } = await supabase.from('notifications').select('id,incident_id,channel,title,body,status,created_at,sent_at,read_at').order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    if (path === '/audit' && req.method === 'GET') {
      if (!['operator', 'super-admin'].includes(profile.role)) return json({ error: 'Not permitted' }, 403);
      const { data, error } = await supabase.from('audit_logs').select('id,actor_id,institution_id,action,resource_type,resource_id,metadata,created_at').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return json({ data: data ?? [] });
    }

    return json({ error: 'Route not found' }, 404);
  } catch (error) {
    const correlationId = crypto.randomUUID();
    const e: any = error;
    // Supabase PostgrestError is a plain object, not an Error instance, so `instanceof Error`
    // alone dropped every RPC/DB rejection message and turned it into an opaque 500.
    const rawMessage = e instanceof Error
      ? e.message
      : (typeof e?.message === 'string' ? e.message : (typeof e === 'string' ? e : ''));
    const message = String(rawMessage || 'Request failed');
    console.error('REACH API request failed', { correlationId, code: e?.code, error: message });

    // Map database/PostgREST codes to the closest HTTP status. P0001 is a deliberate
    // `raise exception` guard inside an RPC, so its message is safe to surface.
    const code = String(e?.code || '');
    const pgStatus: Record<string, number> = {
      P0001: 400,      // raise_exception guard in an RPC
      '23505': 409,    // unique_violation
      '23503': 409,    // foreign_key_violation
      '23514': 422,    // check_violation
      '22P02': 422,    // invalid_text_representation
      '42501': 403,    // insufficient_privilege
      PGRST116: 404,   // no rows returned for .single()
      PGRST301: 401,   // JWT expired/invalid
    };
    const embedded = Number(e?.status ?? e?.statusCode);
    let status = pgStatus[code]
      ?? (embedded >= 400 && embedded < 600 ? embedded : undefined);

    if (!status) {
      if (/Authentication required|jwt|token|unauthor/i.test(message)) status = 401;
      else if (/Not permitted|denied|insufficient|forbidden|role required/i.test(message)) status = 403;
      else if (/not found/i.test(message)) status = 404;
      else if (/already|duplicate|conflict/i.test(message)) status = 409;
      else if (/Invalid|required|expired|Cannot|must be|not an active|not eligible|not configured|mismatch/i.test(message)) status = 422;
      else status = 500;
    }

    // Deliberate guard messages (P0001) and every 4xx are caller-facing; only unexpected 5xx
    // failures are hidden behind a generic message so internals never leak.
    const surface = (code === 'P0001' || status < 500) && code !== 'PGRST116';
    return json({ error: surface ? message : 'Request could not be completed', correlation_id: correlationId }, status);
  }
});
