# REACH 0009 Full Source Cross-Check

Date: 2026-09-30

## Result summary
**33/33 intended source checks PASS** (after BillingPlanPage + webhook patches).  
Local: validate PASS, hardening 10/10 PASS, production build PASS.

## AI (standard / advisory)
| Check | Status |
|-------|--------|
| Labelled advisory in Safety Fusion v2 | PASS |
| Abstains on weak/contradictory/stale evidence | PASS |
| Weighted fusion by evidence kind | PASS |
| External model is second opinion only; never authorizes response | PASS |
| AI API keys server-side only (not VITE_) | PASS |
| No operator “approve AI” API | PASS |
| Assessment path present in API stack | PASS |

**Standard of care encoded:** AI scores and routes; desk decides; operator oversees metrics only.

## Relay
| Check | Status |
|-------|--------|
| Server hop ceiling 6 | PASS |
| Server TTL ~30 minutes | PASS |
| Source/relay ECDSA signature verification | PASS |
| Device takeover blocked | PASS |
| UUID cast guarded | PASS |
| Cross-institution binding logic present | PASS |
| Android BLE + Wi-Fi Direct | PASS |
| Android signed packets + durable queue | PASS |
| PWA offline queue / DEMO_MODE config | PASS |

**Effective design:** store-and-forward with crypto identity; physical devices still required for mesh certification.

## Billing / BMONI
| Check | Status |
|-------|--------|
| HTTPS-only BMONI_BASE_URL | PASS |
| No implicit dev endpoint | PASS |
| Official X-Webhook-Signature | PASS |
| Constant-time signature compare | PASS |
| Monotonic settlement (no late downgrade) | PASS |
| Single pending institutional payment | PASS |
| Treasury/amount server-controlled env markers | PASS |
| Payment signature submit import (build) | PASS |

## Auth / tenancy / API
| Check | Status |
|-------|--------|
| Explicit demo mode flag | PASS |
| Citizen-oriented public signup model | PASS |
| Rate limiting | PASS |
| Auth required on API | PASS |
| Migrations 0001–0008 present | PASS |

## Honest limits
This cross-check is **source + local build**. Live RLS, real payments, multi-phone relay, and load/pen tests remain external gates (see setup guide).
