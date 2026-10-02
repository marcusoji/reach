-- REACH AI provider telemetry
-- The model is a second opinion, so "no second opinion was used" is a normal outcome -- but it is
-- not diagnosable. The provider adapter keeps only in-memory state (a consecutive-failure counter
-- and the last failure string), and /system/health reports the AI as 'Configured' purely from env
-- vars. An operator therefore cannot tell "the model declined" from "the model was never called".
--
-- Record every provider attempt so the AI Performance view can show why a second opinion was
-- missing. `failure_kind` distinguishes a provider that answered with unusable content from one
-- that was unreachable; `detail` carries the capped raw text for the former.

create table if not exists public.ai_provider_events (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid references public.institutions(id) on delete set null,
  incident_id uuid references public.incidents(id) on delete set null,
  outcome text not null check (outcome in ('ok','failure')),
  model text,
  failure_kind text,
  detail text,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists ai_provider_events_created_idx
  on public.ai_provider_events (created_at desc);

alter table public.ai_provider_events enable row level security;

-- Writes come from the Edge Function's service-role client, which bypasses RLS. No insert policy
-- exists on purpose: a signed-in client must not be able to forge provider telemetry.
drop policy if exists ai_provider_events_select on public.ai_provider_events;
create policy ai_provider_events_select on public.ai_provider_events for select using (
  public.has_reach_role(array['operator','super-admin']::public.reach_role[])
  or (institution_id is not null and institution_id = public.current_institution_id())
);
