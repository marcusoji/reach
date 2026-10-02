-- REACH evidence ingestion
-- incident_evidence has existed since 0001 but nothing ever wrote to it: every policy was
-- `for insert with check (false)` and no RPC inserted a row. The engine therefore always fused an
-- empty evidence set, so every assessment abstained with `no_usable_evidence`.
--
-- Writes go through this SECURITY DEFINER RPC, called by the Edge Function on the service-role
-- path. That is deliberate: the caller must be able to derive evidence from the incident itself,
-- and RLS forbids exactly that. Handing the derivation to a client-callable RPC would let any
-- signed-in user claim an incident's evidence is corroborated (kind='corroboration' is weighted
-- 0.8, the second-highest kind, and a `corroborates:true` item raises both support and category
-- score). The RPC is instead restricted to service_role, matching ingest_relay_packet_service.
--
-- Evidence rows are a projection of the incident, not independent observations, so re-running the
-- assessment replaces the derived set rather than appending. `source` stays NULL on derived rows:
-- source diversity counts distinct sources, and labelling every derived row 'incident' would
-- inflate that signal with a single real source.

-- The engine reads evidence per incident, newest first.
create index if not exists incident_evidence_incident_created_idx
  on public.incident_evidence (incident_id, created_at desc);

-- The 0001 check constraint predates the fusion engine and does not accept three of its
-- EvidenceKind values (`user_report`, `motion`, `corroboration`), while listing `video`, which the
-- engine does not weight. Extend the constraint to the union so an engine-facing row can be stored,
-- rather than dropping the engine's kinds on write and silently losing evidence.
alter table public.incident_evidence drop constraint if exists incident_evidence_evidence_type_check;
alter table public.incident_evidence add constraint incident_evidence_evidence_type_check
  check (evidence_type in ('image','audio','video','sensor','text','location','relay','motion','user_report','corroboration'));

-- Replace, in one transaction, the engine-facing evidence derived from an incident.
-- p_evidence is an array of {kind, category, confidence, quality, source, corroborates,
-- contradiction, metadata}. Unknown kinds are dropped rather than rejected: the engine treats an
-- unrecognised kind as weight 0.3, which is a silent downgrade, so filtering here keeps the set
-- honest.
create or replace function public.ingest_incident_evidence_service(p_incident_id uuid, p_evidence jsonb)
returns integer
language plpgsql security definer set search_path=public
as $$
declare
  allowed_kinds text[] := array['user_report','image','audio','motion','location','corroboration','relay','sensor','text'];
  item jsonb;
  inserted integer := 0;
begin
  if not exists (select 1 from public.incidents where id=p_incident_id) then
    raise exception 'Incident not found';
  end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' then
    raise exception 'Evidence must be a JSON array';
  end if;

  delete from public.incident_evidence where incident_id=p_incident_id;

  for item in select value from jsonb_array_elements(p_evidence) as t(value) loop
    if jsonb_typeof(item) <> 'object' then continue; end if;
    if coalesce(item->>'kind','') <> all(allowed_kinds) then continue; end if;
    insert into public.incident_evidence(
      incident_id, evidence_type, confidence, metadata, source, content_hash
    ) values (
      p_incident_id,
      item->>'kind',
      -- A non-numeric confidence from a JSON body would raise on cast; keep it null instead.
      case when (item->>'confidence') ~ '^[0-9]+(\.[0-9]+)?$' then least(greatest((item->>'confidence')::numeric,0),100) end,
      -- Quality is a fusion input the engine reads as evidence.metadata.quality; carrying it here
      -- keeps the two representations from drifting.
      coalesce(item->'metadata','{}'::jsonb) || jsonb_build_object('quality', coalesce((item->>'quality')::numeric, 1)),
      nullif(item->>'source',''),
      nullif(item->>'content_hash','')
    );
    inserted := inserted + 1;
  end loop;
  return inserted;
end; $$;

revoke all on function public.ingest_incident_evidence_service(uuid,jsonb) from public;
revoke all on function public.ingest_incident_evidence_service(uuid,jsonb) from anon;
revoke all on function public.ingest_incident_evidence_service(uuid,jsonb) from authenticated;
grant execute on function public.ingest_incident_evidence_service(uuid,jsonb) to service_role;
