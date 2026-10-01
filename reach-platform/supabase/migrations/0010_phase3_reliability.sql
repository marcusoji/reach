-- REACH 0010 Phase 3 reliability
-- Notification idempotency, webhook attempt tracking, relay ingest dedup index

-- 1) Notification delivery idempotency boundary: notification intent uniqueness
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid,
  channel text NOT NULL,
  recipient text NOT NULL,
  provider_message_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','delivered','failed','expired')),
  attempt_count int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel, recipient)
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status
  ON notification_deliveries(status, updated_at);

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

-- Service role manages deliveries; users read own via notifications join (no direct client insert)
DROP POLICY IF EXISTS notification_deliveries_no_client_write ON notification_deliveries;
-- Deny all to authenticated by default (no policy = deny with RLS on for non-owner)

-- 2) Webhook processing attempts (durable inbox already exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bmoni_webhook_events') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'bmoni_webhook_events' AND column_name = 'attempt_count'
    ) THEN
      ALTER TABLE public.bmoni_webhook_events
        ADD COLUMN attempt_count int NOT NULL DEFAULT 0,
        ADD COLUMN last_attempt_at timestamptz,
        ADD COLUMN next_attempt_at timestamptz;
    END IF;
  END IF;
END $$;

-- 3) Relay packet dedup at gateway (stable packet identity)
CREATE TABLE IF NOT EXISTS relay_ingest_dedup (
  packet_key text NOT NULL,
  packet_hash text NOT NULL,
  institution_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  receive_count int NOT NULL DEFAULT 1,
  PRIMARY KEY (packet_key, packet_hash)
);

CREATE INDEX IF NOT EXISTS idx_relay_ingest_dedup_seen ON relay_ingest_dedup(last_seen_at);

ALTER TABLE relay_ingest_dedup ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE notification_deliveries IS 'Idempotent notification sends: unique(notification_id, channel, recipient)';
COMMENT ON TABLE relay_ingest_dedup IS 'Gateway-level dedup for multi-path relay (BLE/Wi-Fi/PWA)';
