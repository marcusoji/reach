export interface ReachSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  user: { id: string; email?: string };
}

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const API_URL = (import.meta.env.VITE_REACH_API_URL || `${SUPABASE_URL}/functions/v1/api`).replace(/\/$/, '');

export const isBackendConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const isDemoMode = import.meta.env.VITE_REACH_DEMO_MODE === 'true';
if (!isBackendConfigured && !isDemoMode) { console.warn('REACH production mode: backend configuration is required; demo fallback is disabled.'); }
const SESSION_KEY = 'reach_backend_session';

function authHeaders(accessToken?: string): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Session storage hardening:
 * - access_token preferred in sessionStorage (tab-scoped)
 * - refresh_token kept in localStorage for continuity across reloads
 * - never put tokens in URLs
 * - logout clears both stores
 */
const ACCESS_KEY = 'reach_access_session';
const REFRESH_KEY = 'reach_refresh_session';

export function getStoredSession(): ReachSession | null {
  try {
    const accessRaw = sessionStorage.getItem(ACCESS_KEY) || localStorage.getItem(SESSION_KEY);
    if (!accessRaw) return null;
    const session = JSON.parse(accessRaw) as ReachSession;
    if (!session?.access_token) return null;
    // Merge refresh from durable store if missing
    if (!session.refresh_token) {
      try {
        const r = localStorage.getItem(REFRESH_KEY);
        if (r) session.refresh_token = JSON.parse(r).refresh_token;
      } catch { /* ignore */ }
    }
    return session;
  } catch {
    return null;
  }
}

export function storeSession(session: ReachSession | null) {
  try {
    if (!session) {
      sessionStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(REFRESH_KEY);
      return;
    }
    // Tab-scoped access token
    sessionStorage.setItem(ACCESS_KEY, JSON.stringify(session));
    // Durable refresh only (minimize long-lived access token exposure)
    if (session.refresh_token) {
      localStorage.setItem(REFRESH_KEY, JSON.stringify({ refresh_token: session.refresh_token, user: session.user }));
    }
    // Legacy key cleared to avoid dual full-token copies
    localStorage.removeItem(SESSION_KEY);
  } catch { /* unavailable storage */ }
}

function sessionFromAuth(data: any): ReachSession {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? (data.expires_in ? Math.floor(Date.now() / 1000) + Number(data.expires_in) : undefined),
    user: data.user,
  };
}

export async function refreshSession(): Promise<ReachSession | null> {
  const current = getStoredSession();
  if (!current?.refresh_token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: current.refresh_token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) { storeSession(null); return null; }
  const next = sessionFromAuth(data); storeSession(next); return next;
}

async function ensureSession(): Promise<ReachSession | null> {
  const session = getStoredSession();
  if (!session) return null;
  if (session.expires_at && session.expires_at * 1000 > Date.now() + 60_000) return session;
  return refreshSession();
}

export async function loginWithBackend(email: string, password: string): Promise<ReachSession> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Unable to sign in');
  const session = sessionFromAuth(data); storeSession(session); return session;
}

export async function signupWithBackend(data: { email: string; password: string; full_name: string; phone?: string }): Promise<ReachSession | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: data.email, password: data.password, data: { full_name: data.full_name, phone: data.phone } }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.msg || result.error_description || 'Unable to create account');
  if (!result.access_token) return null;
  const session = sessionFromAuth(result); storeSession(session); return session;
}

export async function updateProfile(patch: Record<string, unknown>) { return apiFetch<{ data: any }>('/me', { method:'PATCH', body: JSON.stringify(patch) }); }

export async function getProfile(accessToken?: string) {
  const session = accessToken ? null : await ensureSession();
  const token = accessToken || session?.access_token;
  if (!token) throw new Error('Authentication required');
  const res = await fetch(`${API_URL}/me`, { headers: authHeaders(token) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Profile not found');
  return data.data;
}

export async function logoutBackend(accessToken?: string) {
  const session = await ensureSession();
  const token = accessToken || session?.access_token;
  if (token && isBackendConfigured) await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: authHeaders(token) }).catch(() => undefined);
  storeSession(null);
}

export async function apiFetch<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const session = await ensureSession();
  const headers = { ...authHeaders(session?.access_token), ...(options.headers || {}) };
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401 && retry && session?.refresh_token) {
    const refreshed = await refreshSession();
    if (refreshed) return apiFetch<T>(path, options, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export type BackendIncident = {
  id: string; code: string; category: string; status: string; priority: string; title: string;
  location_label?: string; ai_confidence?: number; ai_fp_code?: string; auto_pushed?: boolean; via_relay?: boolean;
  source_channel?: string; delivery_method?: string; reported_at: string; assigned_staff?: string;
};

export async function listIncidents(status?: string): Promise<BackendIncident[]> {
  const result = await apiFetch<{ data: BackendIncident[] }>(`/incidents?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`);
  return result.data || [];
}

export async function createIncident(payload: Record<string, unknown>, idempotencyKey: string) {
  return apiFetch<{ data: BackendIncident }>('/incidents', { method: 'POST', headers: { 'x-idempotency-key': idempotencyKey }, body: JSON.stringify(payload) });
}

export async function assignIncident(id: string, responderId: string) { return apiFetch<{ data: any }>(`/incidents/${id}/assign`, { method:'POST', body: JSON.stringify({ responder_id: responderId }) }); }

export async function changeIncidentStatus(id: string, status: string, verificationState?: string) {
  return apiFetch<{ data: BackendIncident }>(`/incidents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, verification_state: verificationState }) });
}

export async function listResponders() { return apiFetch<{ data: any[] }>('/responders'); }
export async function setMyResponderStatus(status: 'on_duty'|'off_duty') { return apiFetch<{ data:any }>('/responders/me/status',{method:'PATCH',body:JSON.stringify({status})}); }
export async function listTasks() { return apiFetch<{ data: any[] }>('/tasks'); }
export async function changeTaskStatus(id: string, status: string) { return apiFetch<{ data: any }>(`/tasks/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); }
export async function listInstitutions() { return apiFetch<{ data: any[] }>('/institutions'); }
export async function getInstitutionSummary() { return apiFetch<{ data: any }>('/institution/summary'); }
export async function getOperatorSummary() { return apiFetch<{ data: any }>('/operator/summary'); }
export async function getAiAssessments() { return apiFetch<{ data: any[] }>('/ai/assessments'); }
export async function getAiProviderEvents() { return apiFetch<{ data: any[] }>('/ai/provider-events'); }
// Captured evidence (image/audio/sensor/motion). The object is uploaded to Storage first under
// `${userId}/...`, then registered here; the server re-checks that prefix and derives the fusion
// confidence, so a client cannot award itself the strong-kind weights.
export async function attachIncidentEvidence(payload: { incident_id: string; kind: string; storage_path?: string; content_hash?: string; metadata?: Record<string, unknown> }) {
  return apiFetch<{ data: any }>('/evidence', { method: 'POST', body: JSON.stringify(payload) });
}
export async function listIncidentEvidence(incidentId: string) {
  return apiFetch<{ data: any[] }>(`/evidence?incident_id=${encodeURIComponent(incidentId)}`);
}

/** Upload a captured file to Supabase Storage and register it as evidence.
 *
 * The object path MUST start with the uploader's own uid: the storage.objects policy and
 * attach_incident_evidence both require that prefix, so it is not optional. Content-addressed by
 * SHA-256 so re-uploading the same file cannot be counted twice as independent evidence. */
export async function uploadIncidentEvidence(incidentId: string, kind: string, file: File, metadata: Record<string, unknown> = {}) {
  const session = getStoredSession();
  if (!session?.user?.id) throw new Error('Authentication required to attach evidence');
  if (!SUPABASE_URL) throw new Error('Storage is not configured');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const storagePath = `${session.user.id}/${hash}.${ext}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/incident-evidence/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!upload.ok) throw new Error(`Upload failed (${upload.status})`);
  return attachIncidentEvidence({ incident_id: incidentId, kind, storage_path: storagePath, content_hash: hash, metadata: { ...metadata, size: file.size, mime: file.type || null } });
}
// Run the deterministic engine, optionally with an external second opinion. The engine decides;
// a model result only contributes a bounded adjustment and can never force an autonomous action.
export async function runAiAssessment(incidentId: string, payload: { description?: string; evidence?: any[]; reported_category?: string } = {}) {
  return apiFetch<{ data: any }>('/ai/assess', { method: 'POST', body: JSON.stringify({ incident_id: incidentId, ...payload }) });
}
export async function getRelayHealth() { return apiFetch<{ data: any }>('/relay/health'); }
export async function getSystemHealth() { return apiFetch<{ data: any[] }>('/system/health'); }
export async function listAuditLogs() { return apiFetch<{ data: any[] }>('/audit'); }
export async function createInvite(email:string, role:'staff'|'security-desk') { return apiFetch<{code:string}>('/invites',{method:'POST',body:JSON.stringify({email,role})}); }
export async function createInstitution(payload: { name: string; category?: string; city?: string; address?: string }) { return apiFetch<{ institution_id: string }>('/institutions', { method: 'POST', body: JSON.stringify(payload) }); }
export async function redeemInvite(code: string) { return apiFetch<{ data: any }>('/invites/redeem', { method: 'POST', body: JSON.stringify({ code }) }); }
export async function provisionOperator(key: string) { return apiFetch<{ data: any }>('/operator/provision', { method: 'POST', body: JSON.stringify({ key }) }); }


export function subscribeToIncidentChanges(onChange: () => void): () => void {
  if (!isBackendConfigured || typeof WebSocket === 'undefined') return () => undefined;
  let stopped = false;
  let socket: WebSocket | null = null;
  let heartbeat: number | undefined;
  let reconnectTimer: number | undefined;
  let attempt = 0;
  let ref = 1;
  let joinRef = '1';

  const connect = async () => {
    if (stopped) return;
    const session = await ensureSession();
    if (!session?.access_token) return;
    const host = new URL(SUPABASE_URL).host;
    socket = new WebSocket(`wss://${host}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}&vsn=1.0.0`);
    socket.onopen = () => {
      attempt = 0;
      joinRef = String(ref);
      socket?.send(JSON.stringify({
        topic: 'realtime:reach-incidents', event: 'phx_join', ref: joinRef, join_ref: joinRef,
        payload: { access_token: session.access_token, config: { broadcast: { ack:false, self:false }, presence:{ enabled:false }, postgres_changes:[{ event:'*', schema:'public', table:'incidents' }], private:false } }
      }));
      heartbeat = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ topic:'phoenix', event:'heartbeat', payload:{}, ref:String(++ref) }));
      }, 25000);
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === 'postgres_changes') onChange();
      } catch { /* ignore malformed frames */ }
    };
        socket.onclose = () => {
      if (heartbeat) window.clearInterval(heartbeat);
      if (stopped) return;
      // Exponential backoff + force token refresh before resubscribe
      const delay = Math.min(30000, Math.round(1000 * Math.pow(1.8, attempt)));
      attempt += 1;
      reconnectTimer = window.setTimeout(async () => {
        try { await refreshSession(); } catch { /* ignore */ }
        void connect();
      }, delay);
    };
    socket.onerror = () => { try { socket?.close(); } catch { /* ignore */ } };

    socket.onerror = () => socket?.close();
  };

  void connect();
  const tokenTimer = window.setInterval(async () => {
    const current = await ensureSession();
    if (current?.access_token && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ topic:'realtime:reach-incidents', event:'access_token', payload:{access_token:current.access_token}, ref:String(++ref), join_ref:joinRef }));
    }
  }, 45000);

  return () => {
    stopped = true;
    if (heartbeat) window.clearInterval(heartbeat);
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    window.clearInterval(tokenTimer);
    try { socket?.send(JSON.stringify({topic:'realtime:reach-incidents',event:'phx_leave',payload:{},ref:String(++ref),join_ref:joinRef})); } catch { /* ignore */ }
    socket?.close(); socket = null;
  };
}

export async function getInstitutionBmoniBilling() {
  return apiFetch<{ data: any }>('/institution/billing/bmoni');
}
export async function createInstitutionBmoniUser(payload: { first_name: string; last_name: string; email: string; phone_number: string }) {
  return apiFetch<{ data: any }>('/institution/billing/bmoni/user', { method: 'POST', body: JSON.stringify(payload) });
}
export async function createBmoniOwnerProofChallenge(walletAddress: string) {
  return apiFetch<{ data: any }>('/institution/billing/bmoni/owner-proof-challenge', { method: 'POST', body: JSON.stringify({ wallet_address: walletAddress }) });
}
export async function createBmoniWallet(payload: { wallet_address: string; owner_proof_challenge_id: string; owner_proof_signature: string }) {
  return apiFetch<{ data: any }>('/institution/billing/bmoni/wallet', { method: 'POST', body: JSON.stringify(payload) });
}
export async function startBmoniNigeria(bvn: string, ngnWalletIndex = 0) {
  return apiFetch<{ data: any }>('/institution/billing/bmoni/start-nigeria', { method: 'POST', body: JSON.stringify({ bvn, ngn_wallet_index: ngnWalletIndex }) });
}
export async function getBmoniOnboardingStatus() { return apiFetch<{ data: any }>('/institution/billing/bmoni/status'); }
export async function getBmoniDepositAccount() { return apiFetch<{ data: any }>('/institution/billing/bmoni/deposit-account'); }
/** Stable idempotency key per institution payment attempt window (24h). Retries reuse the same key. */
function institutionPaymentIdempotencyKey(): string {
  const storageKey = 'reach_bmoni_payment_idempotency_v1';
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { key?: string; ts?: number };
      if (parsed.key && parsed.ts && Date.now() - parsed.ts < 24 * 60 * 60 * 1000) return parsed.key;
    }
  } catch { /* ignore */ }
  const key = crypto.randomUUID();
  try { localStorage.setItem(storageKey, JSON.stringify({ key, ts: Date.now() })); } catch { /* ignore */ }
  return key;
}

export function clearInstitutionPaymentIdempotencyKey() {
  try { localStorage.removeItem('reach_bmoni_payment_idempotency_v1'); } catch { /* ignore */ }
}

export async function prepareBmoniInstitutionPayment(amount?: string) {
  return apiFetch<{ data: any }>('/institution/billing/bmoni/payment/proposal', {
    method: 'POST',
    headers: { 'x-idempotency-key': institutionPaymentIdempotencyKey() },
    body: JSON.stringify(amount ? { amount } : {}),
  });
}
export async function submitBmoniInstitutionPaymentSignature(proposalId: string, signature: string) {
  const result = await apiFetch<{ data: any }>('/institution/billing/bmoni/payment/sign', { method: 'POST', body: JSON.stringify({ proposal_id: proposalId, signature }) });
  clearInstitutionPaymentIdempotencyKey();
  return result;
}

export async function updateBmoniKyc(payload: { personalInfo: Record<string, unknown>; addressDetails: Record<string, unknown>; occupationCode?: string }) { return apiFetch<{ data: any }>('/institution/billing/bmoni/kyc', { method: 'PATCH', body: JSON.stringify(payload) }); }


export async function createOperatorInvitation(email: string) {
  return apiFetch<{ data: { id: string; email: string; token: string; expires_at: string } }>('/operator/invitations', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function acceptOperatorInvitation(token: string) {
  return apiFetch<{ data: any }>('/operator/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function listOperatorInvitations() {
  return apiFetch<{ data: any[] }>('/operator/invitations');
}
