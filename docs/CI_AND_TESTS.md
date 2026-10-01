# CI and test harnesses

## npm scripts (`reach-platform`)
| Script | What it does |
|--------|----------------|
| `npm run validate` | PWA JS + hardening markers |
| `npm run validate:hardening` | 10 static regression checks |
| `npm run test:security` | 12 security static checks |
| `npm run validate:all` | all of the above |
| `npm run build` | `tsc && vite build` |

## GitHub Actions
`.github/workflows/ci.yml` — platform build, PWA syntax, migrations, security-static, Android (if wrapper jar present).

## Manual / staging harnesses (`tests/`)
| File | Use |
|------|-----|
| `rls_tenant_isolation.sql` | Tenant isolation checklist |
| `bmoni_webhook_fixtures.mjs` | Signed webhook payloads |
| `load_incidents_k6.js` | k6 concurrent incidents |
| `PHYSICAL_RELAY_MATRIX.md` | Device matrix (in docs/) |
| `ai_calibration_harness.mjs` | AI evaluation process |

## Android
`relay-node-android/CI.md` — assembleDebug / test / lint.
