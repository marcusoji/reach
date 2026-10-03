-- REACH BMONI webhook flow suite - executable.
--
-- Exercises the real process_bmoni_webhook_event RPC against the migrated schema, with the same
-- argument names the Edge Function passes. A mismatch between the two (a stale argument name)
-- makes PostgREST fail the call with "function ... does not exist", so the sandbox result never
-- reaches the payment/subscription records. This suite pins the contract from the SQL side.
--
-- Usage:
--   psql "$REACH_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/bmoni_webhook_flow.sql
--
-- Every assertion RAISEs on failure, so a non-zero exit means the suite failed.

\set ON_ERROR_STOP on

begin;

-- ---- seed (as superuser) ---------------------------------------------------
insert into institutions (id, name, category, city)
values ('b1111111-1111-1111-1111-111111111111', 'BMONI Sandbox Institution', 'university', 'Lagos')
on conflict (id) do nothing;

insert into subscriptions (id, institution_id, status)
values ('b2222222-2222-2222-2222-222222222222', 'b1111111-1111-1111-1111-111111111111', 'trial')
on conflict (id) do nothing;

insert into payments (id, institution_id, subscription_id, amount, currency, status, provider)
values ('b3333333-3333-3333-3333-333333333333', 'b1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', 1450000, 'CNGN', 'pending', 'BMONI Embedded')
on conflict (id) do nothing;

insert into bmoni_transactions (id, institution_id, subscription_id, payment_id, proposal_id, idempotency_key, amount, currency, status)
values ('b4444444-4444-4444-4444-444444444444', 'b1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', 'b3333333-3333-3333-3333-333333333333', 'prop_sbx_flow', 'idem-sbx-flow', 1450000, 'CNGN', 'pending')
on conflict (id) do nothing;

-- ---- 1. A successful sandbox settlement reaches the MVP records ------------
insert into bmoni_webhook_events (event_id, event_type, signature_verified, payload)
values ('evt_flow_ok', 'payment.completed', true, '{"proposalId":"prop_sbx_flow","status":"successful"}'::jsonb)
on conflict do nothing;

do $$
declare
  result jsonb;
  pay_status text;
  sub_status text;
begin
  -- Exactly the argument set the Edge Function passes (no p_event_type).
  result := public.process_bmoni_webhook_event(
    p_event_id => 'evt_flow_ok',
    p_proposal_id => 'prop_sbx_flow',
    p_provider_transaction_id => null,
    p_status => 'successful',
    p_payload => '{"proposalId":"prop_sbx_flow","status":"successful"}'::jsonb
  );
  if (result->>'processed')::boolean is not true then
    raise exception 'FAIL 1: webhook was not processed (%)', result;
  end if;
  select status into pay_status from public.payments where id = 'b3333333-3333-3333-3333-333333333333';
  select status into sub_status from public.subscriptions where id = 'b2222222-2222-2222-2222-222222222222';
  if pay_status <> 'paid' then
    raise exception 'FAIL 1: successful settlement did not mark the payment paid (status=%)', pay_status;
  end if;
  if sub_status <> 'active' then
    raise exception 'FAIL 1: successful settlement did not activate the subscription (status=%)', sub_status;
  end if;
  if (select paid_at is null from public.payments where id = 'b3333333-3333-3333-3333-333333333333') then
    raise exception 'FAIL 1: payment has no paid_at timestamp';
  end if;
end $$;
\echo 'PASS 1 - sandbox settlement marks the payment paid and the subscription active'

-- ---- 2. A replayed delivery is a no-op -------------------------------------
do $$
declare
  result jsonb;
  attempts_before integer;
begin
  select attempt_count into attempts_before from public.bmoni_webhook_events where event_id = 'evt_flow_ok';
  result := public.process_bmoni_webhook_event(
    p_event_id => 'evt_flow_ok',
    p_proposal_id => 'prop_sbx_flow',
    p_provider_transaction_id => null,
    p_status => 'successful',
    p_payload => '{}'::jsonb
  );
  if (result->>'duplicate')::boolean is not true then
    raise exception 'FAIL 2: replayed event was reprocessed (%)', result;
  end if;
  if (select status from public.payments where id = 'b3333333-3333-3333-3333-333333333333') <> 'paid' then
    raise exception 'FAIL 2: replay changed the payment status';
  end if;
end $$;
\echo 'PASS 2 - a duplicate delivery is ignored and does not change state'

-- ---- 3. A reversal does not leave the institution marked paid --------------
do $$
declare
  result jsonb;
begin
  insert into bmoni_webhook_events (event_id, event_type, signature_verified, payload)
  values ('evt_flow_rev', 'payment.reversed', true, '{"status":"reversed"}'::jsonb) on conflict do nothing;
  result := public.process_bmoni_webhook_event(
    p_event_id => 'evt_flow_rev',
    p_proposal_id => 'prop_sbx_flow',
    p_provider_transaction_id => null,
    p_status => 'reversed',
    p_payload => '{"status":"reversed"}'::jsonb
  );
  if (select status from public.payments where id = 'b3333333-3333-3333-3333-333333333333') <> 'cancelled' then
    raise exception 'FAIL 3: reversal did not cancel the payment';
  end if;
  if (select status from public.subscriptions where id = 'b2222222-2222-2222-2222-222222222222') <> 'past_due' then
    raise exception 'FAIL 3: reversal did not move the subscription to past_due';
  end if;
end $$;
\echo 'PASS 3 - a reversal cancels the payment and marks the subscription past_due'

-- ---- 4. An unknown proposal is rejected, not silently accepted -------------
do $$
begin
  insert into bmoni_webhook_events (event_id, event_type, signature_verified, payload)
  values ('evt_flow_bad', 'payment.completed', true, '{}'::jsonb) on conflict do nothing;
  begin
    perform public.process_bmoni_webhook_event(
      p_event_id => 'evt_flow_bad',
      p_proposal_id => 'prop_missing',
      p_provider_transaction_id => null,
      p_status => 'successful',
      p_payload => '{}'::jsonb
    );
    raise exception 'FAIL 4: a webhook for an unknown proposal was accepted';
  exception when others then
    if sqlerrm like 'FAIL 4%' then raise; end if;
    if sqlerrm not like '%BMONI transaction not found%' then
      raise exception 'FAIL 4: unexpected error for an unknown proposal: %', sqlerrm;
    end if;
  end;
  -- The inbox row must stay unprocessed so the provider's retry is not swallowed. (The
  -- processing_error text is written by the Edge Function's catch, in its own statement; the
  -- RPC's own handler write is rolled back with the failed statement, so it is not asserted here.)
  if (select processed_at is not null from public.bmoni_webhook_events where event_id = 'evt_flow_bad') then
    raise exception 'FAIL 4: the failed event was marked processed, so a retry would be ignored';
  end if;
end $$;
\echo 'PASS 4 - a webhook for an unknown proposal is rejected and left unprocessed for retry'

rollback;

\echo '=== BMONI webhook flow suite complete ==='
