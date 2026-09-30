# REACH Integrated MVP

This package contains the two REACH interfaces over one shared backend:

- `reach-platform/` — React/TypeScript operations platform
- `reach-citizen-pwa/` — citizen emergency PWA
- `reach-platform/supabase/` — PostgreSQL, RLS, workflow functions and Edge API

Start with `reach-platform/REACH_MVP_README.md`.

The MVP preserves the existing visual direction while replacing unsafe demo mutations with authenticated, server-validated workflows.

## Deep technical audit

See `REACH_DEEP_AUDIT.md` for the Bluetooth, Wi-Fi, relay and AI verification boundaries and the automated test results.

## Transport + AI v2 upgrade

This build adds a real native Android transport layer instead of presenting browser APIs as a universal mesh:

- BLE GATT central + peripheral relay
- MTU-safe fragmentation/reassembly
- P-256 device identity in Android Keystore
- signed source packets + signed relay envelopes
- durable native SQLite store-and-forward queue
- Wi-Fi Direct peer discovery, connection and bounded TCP transfer
- PWA Web Bluetooth path where the browser supports it
- authenticated relay gateway ingestion
- source/relay device registration and revocation state
- REACH Safety Fusion v2 with evidence freshness, source diversity, contradiction penalties, model agreement and abstention
- optional external multimodal model as a second opinion
- AI model registry and evaluation tables

See `REACH_TRANSPORT_AI_ARCHITECTURE.md` for the full architecture and limitations.

## Current hardening baseline
The latest package baseline is migration `0008_final_hardening.sql`. See `REACH_NEXT_FIXES.md` and `RELEASE_NOTES_0008.md` for completed source-level hardening and external certification requirements.
