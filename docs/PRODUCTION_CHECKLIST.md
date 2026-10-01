# REACH MVP production verification checklist

## Backend
- [ ] Apply migrations 0001 and 0002 in order.
- [ ] Configure `REACH_ALLOWED_ORIGINS` with exact production origins.
- [ ] Configure a strong `REACH_OPERATOR_PROVISION_KEY`.
- [ ] Enable email verification and password recovery.
- [ ] Confirm `supabase_realtime` includes incidents, incident_assignments and notifications.
- [ ] Confirm Storage policies before enabling evidence uploads.
- [ ] Configure SMS/USSD/voice provider before enabling those channels.
- [ ] Configure payment provider before enabling institutional payment processing.

## Security tests
- [ ] Public signup always produces `citizen`.
- [ ] A citizen cannot update their role, institution or zone.
- [ ] A citizen cannot create an incident for another institution.
- [ ] A citizen cannot directly change incident status except permitted cancellation.
- [ ] A responder cannot update another responder’s task.
- [ ] Cross-institution assignment fails.
- [ ] Relay packets from another institution are rejected.
- [ ] Audit rows cannot be inserted/updated/deleted by a client.
- [ ] API rate limiting returns HTTP 429 after the configured threshold.

## End-to-end flow
1. Citizen registers.
2. Institution admin creates an invitation.
3. Staff/security user redeems the invitation.
4. Institution admin adds the member as a responder.
5. Citizen submits an emergency online.
6. Security desk sees the incident through Realtime.
7. Security desk verifies it.
8. Security desk assigns a responder.
9. Responder accepts and starts response.
10. Responder marks on scene.
11. Responder completes the task and incident becomes resolved.
12. Security desk closes the incident.
13. Citizen tracking reflects the server state.
14. Offline submission is queued and later synchronized without duplication.

## Full error-hardening gate
- [ ] `VITE_REACH_DEMO_MODE=false` in every production frontend build.
- [ ] Production Supabase URL and anon key configured; no fallback auth.
- [ ] Migrations 0001 through 0006 applied in order to a fresh Supabase project.
- [ ] Service-role-only relay ingestion verified; direct authenticated RPC call rejected.
- [ ] Operator provisioning RPC direct call rejected; Edge Function secret required.
- [ ] Citizen/resident/staff/security/responder/operator cannot reach institution billing mutation endpoints.
- [ ] Institution can access only its own billing/account/transactions.
- [ ] BMONI API key and webhook secret exist only as Edge Function secrets.
- [ ] Subscription amount and treasury destination are server controlled.
- [ ] BMONI webhook signature is verified using the exact current BMONI contract before production activation.
- [ ] Duplicate webhook deliveries are idempotent.
- [ ] Failed/reversed BMONI transactions never activate a subscription.
- [ ] Successful settlement activates/extends the institutional subscription only once.
- [ ] Live emergency creation remains available during institutional grace/expiry policy.
- [ ] BLE queue is not deleted before peer acknowledgement.
- [ ] Wi-Fi queue is not deleted before send callback success.
- [ ] Physical relay tests cover disconnect, retry, duplicate, expiry, restart and revoked-device cases.
- [ ] AI output is labelled advisory and field calibration metrics are collected before any production claim.
