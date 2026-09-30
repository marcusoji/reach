-- REACH 0006: production hardening.
-- Privileged operations are no longer callable directly by browser-authenticated users.

revoke all on function public.promote_current_user_to_operator() from authenticated;
revoke all on function public.ingest_authenticated_relay_packet(jsonb) from authenticated;

create or replace function public.ingest_relay_packet_service(
  p_packet jsonb,
  p_actor_id uuid
) returns public.relay_packets
language plpgsql security definer set search_path=public
as $$
declare r public.relay_packets; incident_inst uuid; hops int; maxh int; expires timestamptz; pkey text; phash text; src text; src_key text; relay text;
begin
  if p_actor_id is null then raise exception 'Actor required'; end if;
  pkey := trim(coalesce(p_packet->>'packet_key','')); phash := trim(coalesce(p_packet->>'packet_hash',''));
  src := trim(coalesce(p_packet->>'source_device_id','')); src_key := trim(coalesce(p_packet->>'source_public_key','')); relay := trim(coalesce(p_packet->>'relay_device_id',''));
  hops := coalesce((p_packet->>'hop_count')::int,0); maxh := coalesce((p_packet->>'max_hops')::int,6);
  expires := coalesce((p_packet->>'ttl_expires_at')::timestamptz, now()+interval '30 minutes');
  if length(pkey)<8 or length(phash)<32 or length(src)<8 or length(src_key)<40 then raise exception 'Packet identity required'; end if;
  if not public.authorize_relay_source(src,src_key) then raise exception 'Unregistered or revoked source device'; end if;
  if relay <> '' and not public.authorize_relay_source(relay,trim(coalesce(p_packet->>'relay_public_key',''))) then raise exception 'Unregistered or revoked relay device'; end if;
  if hops<0 or maxh<1 or maxh>6 or hops>=maxh or expires<=now() then raise exception 'Expired or invalid relay packet'; end if;
  if nullif(trim(p_packet->>'incident_id'),'') is null then raise exception 'Incident ID required'; end if;
  select institution_id into incident_inst from public.incidents where id=(p_packet->>'incident_id')::uuid;
  if not found then raise exception 'Incident not found'; end if;
  if incident_inst is not null and not exists(select 1 from public.profiles where id=p_actor_id and (institution_id=incident_inst or role in ('operator','super-admin'))) then raise exception 'Relay packet belongs to another institution'; end if;
  insert into public.relay_packets(packet_key,incident_id,source_device_id,relay_device_id,hop_count,max_hops,ttl_expires_at,status,packet_hash,minimal_payload,received_at,source_public_key,relay_public_key,signature,signed_payload,transport,received_by_device_id)
  values(pkey,(p_packet->>'incident_id')::uuid,left(src,160),left(relay,160),hops,maxh,expires,'received',phash,coalesce(p_packet->'minimal_payload','{}'::jsonb),now(),left(src_key,4096),left(p_packet->>'relay_public_key',4096),left(p_packet->>'signature',4096),left(p_packet->>'signed_payload',12000),left(coalesce(p_packet->>'transport','unknown'),30),left(coalesce(p_packet->>'received_by_device_id',''),160))
  on conflict(packet_key) do update set relay_device_id=excluded.relay_device_id,relay_public_key=excluded.relay_public_key,status=case when public.relay_packets.status='delivered' then 'delivered' else 'received' end,received_at=now()
  returning * into r;
  update public.device_registrations set last_seen_at=now(),last_relay_at=now(),updated_at=now() where device_id=src and status='active';
  if relay is not null and relay<>'' then update public.device_registrations set last_seen_at=now(),last_relay_at=now(),updated_at=now() where device_id=relay and status='active'; end if;
  return r;
end; $$;
revoke all on function public.ingest_relay_packet_service(jsonb,uuid) from public;
grant execute on function public.ingest_relay_packet_service(jsonb,uuid) to service_role;

-- Never expose the operator provisioning primitive to the browser. The trusted Edge Function
-- validates REACH_OPERATOR_PROVISION_KEY before using the service role to change the profile.
