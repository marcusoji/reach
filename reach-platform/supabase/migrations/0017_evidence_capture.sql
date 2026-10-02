-- REACH citizen evidence capture
-- 0015 gave the engine a persisted evidence set, but derived it entirely from what the incident
-- already recorded. The strong kinds -- image, audio, sensor, motion -- still had no capture path,
-- so the second-highest fusion weights were unreachable. This adds the missing path.
--
-- Uploads are authorised by the storage.objects policy below, which requires the object's first
-- path segment to be the uploader's own uid. That prefix is also enforced here: without it a caller
-- could reference another user's object in `storage_path` and have it counted as their evidence.

insert into storage.buckets (id, name, public)
values ('incident-evidence', 'incident-evidence', false)
on conflict (id) do nothing;

drop policy if exists incident_evidence_objects_select on storage.objects;
create policy incident_evidence_objects_select on storage.objects for select using (
  bucket_id = 'incident-evidence'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists incident_evidence_objects_insert on storage.objects;
create policy incident_evidence_objects_insert on storage.objects for insert with check (
  bucket_id = 'incident-evidence'
  and (storage.foldername(name))[1] = auth.uid()::text
);

grant select, insert on storage.objects to authenticated;

-- Attach captured evidence to an incident the caller may act on.
--
-- Client-callable, unlike ingest_incident_evidence_service: a citizen legitimately uploads their own
-- photo. `kind` is restricted to the capture kinds and the fusion confidence is derived here rather
-- than taken from the client, so a caller cannot hand themselves the strong-kind weights
-- (`corroboration` is deliberately excluded: it must mean independent corroboration, not a
-- self-asserted flag).
create or replace function public.attach_incident_evidence(
  p_incident_id uuid,
  p_kind text,
  p_storage_path text default null,
  p_content_hash text default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.incident_evidence
language plpgsql security definer set search_path=public
as $$
declare
  i public.incidents%rowtype;
  created public.incident_evidence;
  allowed_kinds text[] := array['image','audio','video','sensor','motion','text','location'];
  base_confidence numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_kind is null or p_kind <> all(allowed_kinds) then
    raise exception 'Unsupported evidence kind: %', coalesce(p_kind, 'null');
  end if;

  select * into i from public.incidents where id = p_incident_id;
  if not found then raise exception 'Incident not found'; end if;
  if i.reporter_id <> auth.uid()
     and i.institution_id is distinct from public.current_institution_id()
     and not public.has_reach_role(array['operator','super-admin']::public.reach_role[]) then
    raise exception 'Not permitted';
  end if;

  -- Cap the evidence attached to one incident so a single caller cannot flood the fusion.
  if (select count(*) from public.incident_evidence where incident_id = p_incident_id) >= 20 then
    raise exception 'Evidence limit reached for this incident';
  end if;

  if p_storage_path is not null then
    -- Only the caller's own uploads, and no traversal out of that prefix.
    if p_storage_path !~ ('^' || auth.uid()::text || '/') or p_storage_path like '%..%' then
      raise exception 'Storage path must be inside your own evidence prefix';
    end if;
    if not exists (
      select 1 from storage.objects
       where bucket_id = 'incident-evidence' and name = p_storage_path
    ) then
      raise exception 'Uploaded object not found';
    end if;
  end if;

  -- Capture kinds carry more weight than an unsupported report, but less than independent
  -- corroboration, and the value is never taken from the client.
  base_confidence := case p_kind
    when 'image' then 72
    when 'audio' then 62
    when 'video' then 60
    when 'sensor' then 58
    when 'motion' then 45
    when 'text' then 55
    when 'location' then 45
  end;

  insert into public.incident_evidence(
    incident_id, evidence_type, confidence, metadata, storage_path, content_hash, source
  ) values (
    p_incident_id, p_kind, base_confidence,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('captured', true),
    p_storage_path, p_content_hash, null
  ) returning * into created;

  insert into public.audit_logs(actor_id, institution_id, action, resource_type, resource_id, metadata)
  values (auth.uid(), i.institution_id, 'evidence.attached', 'incident_evidence', created.id,
          jsonb_build_object('kind', p_kind, 'incident_id', p_incident_id, 'has_object', p_storage_path is not null));
  return created;
end; $$;

revoke all on function public.attach_incident_evidence(uuid,text,text,text,jsonb) from public;
revoke all on function public.attach_incident_evidence(uuid,text,text,text,jsonb) from anon;
grant execute on function public.attach_incident_evidence(uuid,text,text,text,jsonb) to authenticated;

-- 0015's ingest RPC replaced *all* evidence for an incident. Now that captured evidence exists, that
-- would delete a citizen's photo the moment an operator ran an assessment. Restrict the replace to
-- rows the deriver itself wrote, tagged `derived: true`, so captured rows survive. Captured rows are
-- never `derived`, and the marker is merged after the client metadata, so a caller cannot forge it.
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

  delete from public.incident_evidence
   where incident_id = p_incident_id
     and coalesce(metadata->>'derived', 'false') = 'true';

  for item in select value from jsonb_array_elements(p_evidence) as t(value) loop
    if jsonb_typeof(item) <> 'object' then continue; end if;
    if coalesce(item->>'kind','') <> all(allowed_kinds) then continue; end if;
    insert into public.incident_evidence(
      incident_id, evidence_type, confidence, metadata, source, content_hash
    ) values (
      p_incident_id,
      item->>'kind',
      case when (item->>'confidence') ~ '^[0-9]+(\.[0-9]+)?$' then least(greatest((item->>'confidence')::numeric,0),100) end,
      coalesce(item->'metadata','{}'::jsonb)
        || jsonb_build_object('quality', coalesce((item->>'quality')::numeric, 1))
        || jsonb_build_object('derived', true),
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
