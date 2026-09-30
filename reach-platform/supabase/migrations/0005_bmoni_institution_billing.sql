-- REACH 0005: BMONI Embedded billing for institutions only.
-- Citizens, residents, staff, security desk users, responders and operators do not pay.

create table if not exists public.bmoni_institution_accounts (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null unique references public.institutions(id) on delete cascade,
  bmoni_user_id text unique,
  smart_wallet_id text unique,
  wallet_address text,
  currency text not null default 'CNGN' check (currency = 'CNGN'),
  onboarding_status text not null default 'not_started' check (onboarding_status in ('not_started','user_created','wallet_provisioning','wallet_created','ngn_started','active','action_required','failed')),
  bvn_verified boolean not null default false,
  ngn_virtual_account_ready boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bmoni_transactions (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  bmoni_user_id text,
  smart_wallet_id text,
  proposal_id text,
  bmoni_transaction_id text,
  idempotency_key text not null,
  type text not null default 'subscription_payment' check (type = 'subscription_payment'),
  direction text not null default 'debit' check (direction = 'debit'),
  amount numeric(24,8) not null check (amount > 0),
  currency text not null default 'CNGN' check (currency = 'CNGN'),
  status text not null default 'initiated' check (status in ('initiated','pending','successful','failed','reversed','cancelled')),
  sign_payload text,
  description text,
  failure_reason text,
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(institution_id, idempotency_key)
);

create table if not exists public.bmoni_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_type text not null,
  signature_verified boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

create index if not exists bmoni_transactions_institution_idx on public.bmoni_transactions(institution_id, created_at desc);
create index if not exists bmoni_transactions_proposal_idx on public.bmoni_transactions(proposal_id);
create index if not exists bmoni_transactions_provider_idx on public.bmoni_transactions(bmoni_transaction_id);

create trigger bmoni_institution_accounts_updated_at before update on public.bmoni_institution_accounts for each row execute procedure public.set_updated_at();
create trigger bmoni_transactions_updated_at before update on public.bmoni_transactions for each row execute procedure public.set_updated_at();

alter table public.bmoni_institution_accounts enable row level security;
alter table public.bmoni_transactions enable row level security;
alter table public.bmoni_webhook_events enable row level security;

create policy bmoni_accounts_institution_select on public.bmoni_institution_accounts
  for select using (institution_id = public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));

create policy bmoni_transactions_institution_select on public.bmoni_transactions
  for select using (institution_id = public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));

-- No browser-side insert/update/delete policies: all BMONI mutations happen through the trusted API.
