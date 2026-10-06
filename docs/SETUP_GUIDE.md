# REACH setup guide (Phase 4 package)

## 1. Local platform
```bash
cd reach-platform
npm ci
npm run validate:all
npm run build
```

Demo mode (local only):
```env
VITE_REACH_DEMO_MODE=true
# leave Supabase URL/key empty
```

Production env:
```env
VITE_REACH_DEMO_MODE=false
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_REACH_API_URL=https://YOUR_PROJECT.supabase.co/functions/v1/api
```

## 2. Migrations
Apply in order: `0001` → `0022` (see `reach-platform/supabase/migrations/`).

```bash
supabase db push
supabase functions deploy api
```

Secrets: `REACH_ALLOWED_ORIGINS`, `REACH_OPERATOR_PROVISION_KEY` (bootstrap only), `BMONI_BASE_URL`, `BMONI_API_KEY`, `BMONI_WEBHOOK_SECRET`.

## 3. Operator bootstrap
1. First operator: provision key → super-admin (only while zero operators exist).
2. Further operators: single-use email invitations (`POST /operator/invitations`).

## 4. Android relay
```bash
cd relay-node-android
gradle wrapper --gradle-version 8.7   # once; commit gradle-wrapper.jar
./gradlew assembleDebug
```

## 5. Citizen PWA
Configure `reach-citizen-pwa/js/config.js`; serve over HTTPS/localhost.

## 6. Certification harnesses
See `docs/CI_AND_TESTS.md` and `tests/`.
