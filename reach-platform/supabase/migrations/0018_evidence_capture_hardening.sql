-- Harden the evidence capture path added in 0017.
--
-- 0017 made `storage_path` optional for every kind, so a client could call
-- attach_incident_evidence(incident, 'image') with no upload at all. The RPC would then award the
-- image confidence (72) on its own word, and the engine fuses that with the image weight (0.9 in
-- ai_engine, the highest of any kind). The `captured` marker is meant to mean "an independent
-- sensor produced this", so the strong kinds must be contingent on an actual uploaded object, not
-- on the caller's word.
--
-- The capture kinds are also narrowed. `sensor` and `motion` describe device integrations the PWA
-- cannot perform, so they stay reachable only through the service-role derived path, where the
-- server decides the weight.

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
  allowed_kinds text[] := array['image','audio','video','text','location'];
  media_kinds text[] := array['image','audio','video'];
  expected_mime text;
  object_mime text;
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

  -- Media kinds carry the strong weights, so they require a real object in the evidence bucket.
  if p_kind = any(media_kinds) then
    if p_storage_path is null then
      raise exception 'A storage path is required for % evidence', p_kind;
    end if;
    if p_content_hash is null then
      raise exception 'A content hash is required for % evidence', p_kind;
    end if;
  end if;

  if p_storage_path is not null then
    -- Only the caller's own uploads, and no traversal out of that prefix.
    if p_storage_path !~ ('^' || auth.uid()::text || '/') or p_storage_path like '%..%' then
      raise exception 'Storage path must be inside your own evidence prefix';
    end if;
    -- The object must exist, and its recorded content type must match the claimed kind, so an
    -- unrelated file cannot be presented as captured media.
    select metadata->>'mimetype' into object_mime
      from storage.objects where bucket_id = 'incident-evidence' and name = p_storage_path;
    if not found then raise exception 'Uploaded object not found'; end if;
    if p_kind = any(media_kinds) then
      expected_mime := case p_kind when 'image' then 'image/' when 'audio' then 'audio/' else 'video/' end;
      if object_mime is null or left(object_mime, length(expected_mime)) <> expected_mime then
        raise exception 'Uploaded object is not % evidence (content type %)', p_kind, coalesce(object_mime, 'unknown');
      end if;
    end if;
  end if;

  -- Derived server-side from the kind, never taken from the client.
  base_confidence := case p_kind
    when 'image' then 72
    when 'audio' then 62
    when 'video' then 60
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
