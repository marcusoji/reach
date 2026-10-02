-- REACH 0013: relay ingest hardening found in the deep AI/relay audit.
--
-- 1) Gateway dedup atomicity. The Edge Function recorded a delivery by reading receive_count
--    and then writing read+1. Under the multi-path case this table exists for -- the same
--    packet arriving over BLE, Wi-Fi and PWA at nearly the same moment -- the read-then-write
--    lost updates and the losing writers raised duplicate-key errors on the primary key.
--    record_relay_ingest_dedup() replaces it with a single atomic upsert.
--
-- 2) Tenant-scoped packet idempotency. ingest_relay_packet_service() short-circuited on
--    packet_key alone. packet_key is client-supplied, so an institution replaying another
--    institution's packet_key was handed that institution's relay_packets row (cross-tenant
--    disclosure) and its own incident was silently dropped. The idempotency lookup is now
--    scoped to the packet's source device, which the function has already validated against
--    device_registrations.

create or replace function public.record_relay_ingest_dedup(
  p_packet_key text,
  p_packet_hash text,
  p_institution_id uuid
) returns void
language sql security definer set search_path=public
as $$
  insert into public.relay_ingest_dedup(packet_key,packet_hash,institution_id,receive_count,first_seen_at,last_seen_at)
  values (left(p_packet_key,160), left(p_packet_hash,256), p_institution_id, 1, now(), now())
  on conflict (packet_key,packet_hash) do update
    set receive_count = public.relay_ingest_dedup.receive_count + 1,
        last_seen_at = now();
$$;
revoke all on function public.record_relay_ingest_dedup(text,text,uuid) from public;
grant execute on function public.record_relay_ingest_dedup(text,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Tenant-scoped relay ingest idempotency (full redefinition of the 0008 function).
-- ---------------------------------------------------------------------------
create or replace function public.ingest_relay_packet_service(
  p_packet jsonb,
  p_actor_id uuid
) returns public.relay_packets
language plpgsql security definer set search_path=public
as $$
declare
  r public.relay_packets;
  existing public.relay_packets;
  incident_row public.incidents;
  actor_profile public.profiles;
  source_profile public.profiles;
  source_device_user uuid;
  source_institution uuid;
  actor_is_platform boolean := false;
  incident_uuid uuid := null;
  pkey text := trim(coalesce(p_packet->>'packet_key',''));
  phash text := trim(coalesce(p_packet->>'packet_hash',''));
  src text := trim(coalesce(p_packet->>'source_device_id',''));
  src_key text := trim(coalesce(p_packet->>'source_public_key',''));
  relay text := trim(coalesce(p_packet->>'relay_device_id',''));
  relay_key text := trim(coalesce(p_packet->>'relay_public_key',''));
  hops int := coalesce((p_packet->>'hop_count')::int,0);
  requested_maxh int := coalesce((p_packet->>'max_hops')::int,6);
  maxh int := least(greatest(requested_maxh,1),6);
  expires timestamptz;
  mp jsonb := coalesce(p_packet->'minimal_payload','{}'::jsonb);
  category_text text := lower(coalesce(mp->>'category','other'));
  priority_text text := lower(coalesce(mp->>'priority','high'));
  title_text text := left(coalesce(mp->>'title', initcap(category_text) || ' emergency'), 240);
  description_text text := left(coalesce(mp->>'description','Emergency received through REACH relay transport.'), 4000);
  location_label_text text := left(nullif(mp->>'location_label',''), 500);
  location_source_text text := nullif(mp->>'location_source','');
  lat numeric;
  lon numeric;
  accuracy numeric;
  reporter uuid;
  raw_incident_id text := trim(coalesce(p_packet->>'incident_id',''));
begin
  if p_actor_id is null then raise exception 'Actor required'; end if;
  if length(pkey)<8 or length(phash)<32 or length(src)<8 or length(src_key)<40 then raise exception 'Packet identity required'; end if;

  select * into actor_profile from public.profiles where id=p_actor_id;
  if not found then raise exception 'Actor profile not found'; end if;
  actor_is_platform := actor_profile.role in ('operator','super-admin');

  -- Never trust a client-supplied max beyond the server ceiling.
  if hops < 0 or hops >= maxh or requested_maxh < 1 or requested_maxh > 6 then
    raise exception 'Invalid relay hop values';
  end if;

  begin
    expires := nullif(p_packet->>'ttl_expires_at','')::timestamptz;
  exception when others then
    raise exception 'Invalid relay expiration';
  end;
  if expires is null then raise exception 'Relay expiration required'; end if;
  if expires <= now() or expires > now() + interval '30 minutes' then
    raise exception 'Relay packet exceeds server TTL limit';
  end if;

  select d.user_id into source_device_user
  from public.device_registrations d
  where d.device_id=src and d.public_key=src_key and d.status='active';
  if source_device_user is null then raise exception 'Unregistered or revoked source device'; end if;

  select p.* into source_profile from public.profiles p where p.id=source_device_user;
  if not found then raise exception 'Source device owner profile not found'; end if;
  source_institution := source_profile.institution_id;
  reporter := source_device_user;

  -- A normal authenticated relay receiver may only process packets originating
  -- from the same institution. Platform roles may bridge institutions.
  if not actor_is_platform and actor_profile.institution_id is distinct from source_institution then
    raise exception 'Relay source belongs to another institution';
  end if;

  if relay <> '' then
    if not public.authorize_relay_source(relay,relay_key) then
      raise exception 'Unregistered or revoked relay device';
    end if;
    if relay = src then
      raise exception 'Source and relay device cannot be identical';
    end if;
  end if;

  -- Preserve the first packet exactly. Never overwrite its security identity.
  -- Scope idempotency to the packet's own source device. packet_key is client-supplied: without
  -- this, an institution replaying another institution's packet_key was handed that
  -- institution's relay_packets row (cross-tenant disclosure) and its own incident was
  -- silently dropped by the existing-row short-circuit.
  select * into existing from public.relay_packets where packet_key=pkey and source_device_id=src for update;
  if found then return existing; end if;

  -- packet_key is globally unique by design (client-generated). A collision from a *different*
  -- source device is a client anomaly or a replay attempt: reject it explicitly rather than
  -- returning another tenant's row (the previous short-circuit disclosed it) or surfacing a
  -- raw unique-constraint error on insert.
  if exists (select 1 from public.relay_packets where packet_key=pkey and source_device_id is distinct from src) then
    raise exception 'Relay packet key already used by another source device';
  end if;

  -- Only cast an incident identifier after strict UUID-shape validation.
  if raw_incident_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    incident_uuid := raw_incident_id::uuid;
    select * into incident_row from public.incidents where id=incident_uuid for update;
    if not found then incident_uuid := null; end if;
  end if;

  if incident_uuid is not null then
    if incident_row.institution_id is not null and source_institution is distinct from incident_row.institution_id then
      raise exception 'Relay packet belongs to another institution';
    end if;
  else
    if category_text not in ('medical','fire','security','accident','other') then category_text := 'other'; end if;
    if priority_text not in ('low','medium','high','critical') then priority_text := 'high'; end if;
    begin lat := nullif(mp->>'latitude','')::numeric; exception when others then lat := null; end;
    begin lon := nullif(mp->>'longitude','')::numeric; exception when others then lon := null; end;
    begin accuracy := nullif(mp->>'location_accuracy_m','')::numeric; exception when others then accuracy := null; end;

    insert into public.incidents(
      institution_id,reporter_id,category,status,priority,title,description,source_channel,
      delivery_method,location_label,location_source,location_accuracy_m,location,location_context,
      via_relay,idempotency_key,reported_at,created_at,updated_at
    ) values (
      source_institution,reporter,category_text::public.incident_category,'received',priority_text::public.incident_priority,
      title_text,description_text,'relay'::public.channel_type,'relay',location_label_text,
      case when location_source_text in ('gps','network','registered','manual','zone','human-relay') then location_source_text else null end,
      accuracy,
      case when lat between -90 and 90 and lon between -180 and 180 then ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography else null end,
      jsonb_build_object('transport','relay','provisional',true,'source_device_id',src),
      true,pkey,now(),now(),now()
    ) returning * into incident_row;
    incident_uuid := incident_row.id;

    insert into public.incident_events(incident_id,actor_id,event_type,to_status,message,metadata)
    values(incident_uuid,p_actor_id,'relay.provisional_received','received','Emergency reconstructed from offline relay packet',jsonb_build_object('packet_key',pkey,'source_device_id',src));
  end if;

  insert into public.relay_packets(
    packet_key,incident_id,source_device_id,relay_device_id,hop_count,max_hops,ttl_expires_at,status,
    packet_hash,minimal_payload,received_at,source_public_key,relay_public_key,signature,signed_payload,
    transport,received_by_device_id
  ) values(
    pkey,incident_uuid,left(src,160),left(relay,160),hops,maxh,expires,'received',phash,mp,now(),
    left(src_key,4096),left(relay_key,4096),
    left(coalesce(p_packet->>'source_signature',p_packet->>'signature'),4096),
    left(coalesce(p_packet->>'source_signed_payload',p_packet->>'signed_payload'),12000),
    left(coalesce(p_packet->>'transport','unknown'),30),left(coalesce(p_packet->>'received_by_device_id',''),160)
  ) returning * into r;

  update public.device_registrations set last_seen_at=now(),last_relay_at=now(),updated_at=now() where device_id=src and status='active';
  if relay <> '' then update public.device_registrations set last_seen_at=now(),last_relay_at=now(),updated_at=now() where device_id=relay and status='active'; end if;
  return r;
end;
$$;
revoke all on function public.ingest_relay_packet_service(jsonb,uuid) from public;
grant execute on function public.ingest_relay_packet_service(jsonb,uuid) to service_role;
