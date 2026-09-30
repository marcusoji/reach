# REACH Citizen PWA — integrated MVP

This is the citizen-facing REACH emergency experience. It uses the same Supabase Auth, PostgreSQL, RLS and Edge Function API as the main operations platform.

## Included

- Account registration and sign-in
- Secure citizen identity handled by Supabase Auth
- Emergency creation against the shared incident model
- GPS permission and location accuracy capture
- Registered/manual location fallback
- Offline IndexedDB emergency queue
- Idempotent retry after reconnection
- Live incident tracking against the server incident UUID
- Trusted-contact CRUD
- Relay participation preference persisted to the backend
- PWA service worker and offline app shell
- Relay packet backend foundation

## Relay limitation

The backend supports relay packets, TTL, hop limits and deduplication. A normal browser cannot guarantee unrestricted background Bluetooth/WebRTC relay on every Android/iOS device. The UI therefore does **not** claim that background relay is universally available. A real device relay adapter should be added using a supported native/OS channel when the target devices and permissions are fixed.

## AI limitation

The default build does not pretend that browser motion, vision or audio integrations are live. Set `DEMO_MODE: true` only for demonstrations. Production incident submissions use zero AI confidence until a real, consented evidence integration writes an assessment to the backend.

## Configure

Edit `js/config.js`:

```js
window.REACH_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
  API_URL: 'https://YOUR_PROJECT.supabase.co/functions/v1/api',
  DEMO_MODE: false
};
```

Never put a Supabase service-role key here.

## Run

Serve this folder over HTTPS (or localhost for development). ES modules, geolocation, service workers and many browser capabilities do not work correctly from `file://`.
