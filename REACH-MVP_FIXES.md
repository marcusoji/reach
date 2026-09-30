# REACH MVP — Completed Hardening Pass

This build addresses the issues identified in the previous audit.

## Fixed

- Privileged signup role escalation: public signup always creates `citizen`.
- Institution account creation: authenticated citizen can create an institution through a server-side transaction and is promoted only by that controlled function.
- Staff/security access: single-use, expiring, email-bound invitations.
- Operator access: server-side provisioning key; no public self-assigned operator role.
- Super-admin: not self-assignable.
- Profile privilege tampering: role, institution and zone are protected by a database trigger.
- Cross-institution incident injection: incident institution is derived from the authenticated profile.
- Direct incident mutation: client-side update policies are closed; workflow functions enforce state transitions.
- Invalid incident transitions: server-side state machine.
- Cross-institution responder assignment: server-side institution check.
- Responder task ownership: only the assigned responder can advance their task.
- Relay packet ingestion: authenticated function, tenant check, idempotent packet key, TTL and hop validation.
- Broad relay reads: scoped by incident/institution.
- Direct notification insertion: closed; system trigger/function creates notifications.
- Audit log tampering: client insert/update/delete removed.
- API rate limiting: authenticated route buckets.
- CORS: allowlist via `REACH_ALLOWED_ORIGINS` instead of wildcard production CORS.
- Auth refresh: access-token expiry is refreshed through the Supabase refresh-token endpoint.
- Backend role spoofing: login role selector is ignored when backend is configured.
- Static/demo data: live-configured operation pages no longer depend on fake incident/operator/notification/health data.
- Security desk workflow: verify → assign → respond → on scene → resolve → close.
- Responder workflow: assigned → accepted → responding → on scene → completed.
- Responder directory and roster management.
- Institution invitations from the security roster page.
- Trusted-contact backend CRUD.
- Emergency-contact notification queue on incident creation.
- Real GPS capture with accuracy metadata.
- PWA tracking uses the real incident UUID after synchronization.
- Offline queue synchronization keeps idempotency and maps queued incidents to real server IDs.
- Non-retryable client validation errors are no longer endlessly queued as offline incidents.
- Service worker no longer caches cross-origin authenticated API responses.
- PWA no longer ships filled demo credentials.
- Fake “call placed”, “payment completed”, “AI confidence”, and “background Bluetooth works everywhere” claims were removed or clearly marked as demo/unsupported integrations.
- PWA install icons added in 192px and 512px sizes.
- Supabase Realtime incident subscription added with polling fallback.
- Realtime publication migration added for incident operational updates.
- Operator AI/relay/system/audit screens now use backend data or explicit empty states.
- Billing UI no longer fabricates successful payments.

## Validation performed

- All Citizen PWA JavaScript files pass Node syntax checking.
- Edge Function TypeScript passes an isolated TypeScript syntax/type parse with Deno/Supabase stubs.
- React source was checked with an isolated TypeScript parse; the remaining reported issues in that environment are caused by unavailable real npm React/type packages, not source syntax. The real `npm ci` could not complete because the environment timed out while downloading dependencies.
- `npm run validate` passes.
- PWA and platform HTML parse successfully.
- Manifest and package JSON parse successfully.
- Required security/workflow controls are checked by the included validation script.

## Important boundary

This is now a hardened MVP foundation, not a claim that external providers are magically live. SMS/USSD/voice, payments, real sensor/AI integrations, evidence storage, push notifications and device-native Bluetooth/WebRTC relay still require their real providers/adapters and production credentials before those capabilities are advertised as live.
