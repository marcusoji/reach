# REACH MVP — Integrated Build

This package combines the REACH operations platform and Citizen PWA over one backend and one incident model.

## Stack

- React + Vite + TypeScript — operations platform
- Vanilla PWA — citizen/mobile experience
- Supabase PostgreSQL — shared relational model
- Supabase Auth — identity
- PostgreSQL Row Level Security — tenant and role isolation
- Supabase Edge Function — authenticated business API
- Supabase Realtime — live incident updates with polling fallback
- IndexedDB + Service Worker — citizen offline queue/cache
- PostGIS — location storage

## Domain

`profiles → institutions → memberships → zones → responders → incidents → evidence → AI assessments → assignments → incident events → relay packets → notifications → broadcasts → billing → audit logs`

## Incident lifecycle

`Reported → Received → Verifying → Verified → Assigned → Responding → On Scene → Resolved → Closed`

Citizens can cancel their own early-stage incidents. Other transitions are server-side validated.

## Security model

- Public signup always creates a **citizen** profile.
- Institution admins are created through the authenticated institution-creation workflow.
- Staff/security-desk accounts require a single-use, expiring invitation.
- Operator provisioning requires a server-side provisioning secret.
- Super-admin is not publicly self-assignable.
- Role, institution and zone privilege changes are protected by a database trigger.
- Incident creation derives institution from the authenticated profile.
- Incident status changes use a server-side state machine.
- Responder assignment is institution-scoped.
- Relay ingestion is authenticated, tenant-scoped, idempotent and TTL/hop limited.
- Audit records are server-created and operator-readable.
- Client-side direct mutation policies are intentionally restrictive.
- API rate limiting is enforced per authenticated user/route.
- API CORS is allowlist-based through `REACH_ALLOWED_ORIGINS`.

## Offline behavior

1. Citizen creates an emergency.
2. If online, the API creates the incident immediately.
3. If offline or temporarily unavailable, IndexedDB stores the payload with an idempotency key.
4. Reconnection retries the queued payload.
5. The server's `(reporter_id, idempotency_key)` uniqueness prevents duplicate incidents.
6. Once synchronized, the PWA replaces the local queue identifier with the real server incident UUID.

## Realtime

The operations platform subscribes to Supabase Realtime incident changes and refreshes its server-backed queue immediately. A slower polling refresh remains as a resilience fallback. The migration adds `incidents`, `incident_assignments`, and `notifications` to the `supabase_realtime` publication when that publication exists.

## AI

The schema supports AI assessments, evidence references, confidence and decision mode. The browser prototype does not fabricate live sensor/vision/audio data in production mode. A real AI/evidence provider should write assessments through a server-side integration and preserve the human-confirmation boundary.

## Feature phone / SMS / voice

The incident model already supports `ussd`, `sms`, `voice`, `ivr`, `relay`, and `human-relay` channels. Provider webhooks are not claimed as live until a provider is configured and tested.

## Billing

Billing is institution-level. The UI no longer pretends a payment was completed. A real provider must be connected server-side before payments are enabled.

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/migrations/0001_reach_mvp.sql`.
3. Run `supabase/migrations/0002_security_and_workflows.sql`.
4. Deploy `supabase/functions/api/index.ts` as the `api` Edge Function.
5. Configure server-side secrets:
   - `REACH_ALLOWED_ORIGINS`
   - `REACH_OPERATOR_PROVISION_KEY`
6. Configure the React `.env.local` with the Supabase URL, anon key and API URL.
7. Configure the Citizen PWA `js/config.js` with the same public URL/anon key/API URL.
8. Enable email verification/password recovery in Supabase Auth before production.
9. Test RLS and the complete incident lifecycle with separate test users for each role.

## Important deployment rules

- Never expose a service-role key in `VITE_*` variables or the PWA.
- Do not claim SMS/USSD/voice, live AI, payment processing or guaranteed background Bluetooth relay until their providers/device adapters are actually connected and tested.
- Serve the PWA over HTTPS in production.
- Configure the exact production frontend origins in `REACH_ALLOWED_ORIGINS`.

### AI configuration

The production-safe default is the REACH Safety Fusion engine. An optional server-side model adapter can be enabled with `REACH_AI_ENDPOINT`, `REACH_AI_API_KEY`, and `REACH_AI_MODEL`. External model output is validated and fused with deterministic evidence rules; it cannot directly verify or resolve an emergency. The API key must remain server-side.
