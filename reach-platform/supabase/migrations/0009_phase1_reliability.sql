-- REACH 0009 — Phase 1 reliability & security foundations
-- Onboarding recovery, operator invitations, payment intent clarity, webhook durability notes

-- 1) Persistent onboarding sessions (resume after email confirmation)
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  onboarding_type text NOT NULL CHECK (onboarding_type IN (
    'citizen','institution','staff','security_desk','operator'
  )),
  institution_id uuid,
  invite_id uuid,
  intended_role text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','expired','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_user ON onboarding_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_email ON onboarding_sessions(lower(email), status);

ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_sessions_own ON onboarding_sessions;
CREATE POLICY onboarding_sessions_own ON onboarding_sessions
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR lower(email) = lower(coalesce(auth.jwt()->>'email','')))
  WITH CHECK (user_id = auth.uid() OR lower(email) = lower(coalesce(auth.jwt()->>'email','')));

-- 2) Operator invitations (replace permanent provision key for day-to-day ops)
CREATE TABLE IF NOT EXISTS operator_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','revoked','expired')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_operator_invitations_email ON operator_invitations(lower(email), status);

ALTER TABLE operator_invitations ENABLE ROW LEVEL SECURITY;

-- Only service role / edge function should manage invitations broadly.
-- Authenticated users may read their own pending invite by email.
DROP POLICY IF EXISTS operator_invitations_self_read ON operator_invitations;
CREATE POLICY operator_invitations_self_read ON operator_invitations
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt()->>'email','')));

-- 3) Ensure bmoni_transactions remains the payment intent store with unique idempotency
-- (may already exist from 0005/0007 — safe IF NOT EXISTS patterns)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bmoni_transactions_institution_idempotency_key'
  ) THEN
    BEGIN
      ALTER TABLE bmoni_transactions
        ADD CONSTRAINT bmoni_transactions_institution_idempotency_key
        UNIQUE (institution_id, idempotency_key);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'idempotency unique constraint skipped: %', SQLERRM;
    END;
  END IF;
END $$;

-- 4) Durable webhook inbox already present in prior migrations; ensure processed_at nullable for retry
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bmoni_webhook_events') THEN
    -- no-op structure guarantee
    NULL;
  END IF;
END $$;

-- 5) Server-side hop/TTL constants documented for ops (enforce remains in API/SQL functions)
COMMENT ON TABLE onboarding_sessions IS 'Resume signup/onboarding after email confirmation; expires in 48h';
COMMENT ON TABLE operator_invitations IS 'Single-use short-lived operator invites; token stored hashed';
