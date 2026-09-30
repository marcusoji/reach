-- REACH 0007: relay provisional incidents + immutable packet replay handling + atomic BMONI settlement.

-- Relay packets may arrive before an internet-connected incident row exists.
-- The trusted service function derives tenant ownership from the registered relay device's user.
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
  actor_institution uuid;
  device_user uuid;
  incident_uuid uuid := nullif(trim(coalesce(p_packet->>'incident_id','')), '')::uuid;
  pkey text := trim(coalesce(p_packet->>'packet_key',''));
  phash text := trim(coalesce(p_packet->>'packet_hash',''));
  src text := trim(coalesce(p_packet->>'source_device_id',''));
  src_key text := trim(coalesce(p_packet->>'source_public_key',''));
  relay text := trim(coalesce(p_packet->>'relay_device_id',''));
  relay_key text := trim(coalesce(p_packet->>'relay_public_key',''));
  hops int := coalesce((p_packet->>'hop_count')::int,0);
  maxh int := least(greatest(coalesce((p_packet->>'max_hops')::int,6),1),6);
  expires timestamptz := coalesce(nullif(p_packet->>'ttl_expires_at','')::timestamptz, now()+interval '30 minutes');
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
  source_channel public.channel_type := 'relay';
  reporter uuid;
begin
  if p_actor_id is null then raise exception 'Actor required'; end if;
  if length(pkey)<8 or length(phash)<32 or length(src)<8 or length(src_key)<40 then raise exception 'Packet identity required'; end if;
  if hops<0 or hops>=maxh or maxh>6 or expires<=now() then raise exception 'Expired or invalid relay packet'; end if;

  select d.user_id into device_user
  from public.device_registrations d
  where d.device_id=src and d.public_key=src_key and d.status='active';
  if device_user is null then raise exception 'Unregistered or revoked source device'; end if;

  select p.institution_id into actor_institution from public.profiles p where p.id=p_actor_id;
  select p.institution_id into actor_institution from public.profiles p where p.id=device_user;
  reporter := device_user;

  if relay <> '' and not public.authorize_relay_source(relay,relay_key) then
    raise exception 'Unregistered or revoked relay device';
  end if;

  -- Replay/idempotency: never mutate the original packet's security identity.
  select * into existing from public.relay_packets where packet_key=pkey for update;
  if found then return existing; end if;

  if incident_uuid is not null then
    select * into incident_row from public.incidents where id=incident_uuid for update;
    if not found then incident_uuid := null; end if;
  end if;

  -- If the offline packet references a local placeholder/nonexistent incident ID,
  -- create a provisional server incident using the source device's tenant.
  if incident_uuid is null then
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
      actor_institution,reporter,category_text::public.incident_category,'received',priority_text::public.incident_priority,
      title_text,description_text,source_channel,'relay',location_label_text,
      case when location_source_text in ('gps','network','registered','manual','zone','human-relay') then location_source_text else null end,
      accuracy,
      case when lat between -90 and 90 and lon between -180 and 180 then ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography else null end,
      jsonb_build_object('transport','relay','provisional',true,'source_device_id',src),
      true,pkey,now(),now(),now()
    ) returning * into incident_row;
    incident_uuid := incident_row.id;

    insert into public.incident_events(incident_id,actor_id,event_type,to_status,message,metadata)
    values(incident_uuid,p_actor_id,'relay.provisional_received','received','Emergency reconstructed from offline relay packet',jsonb_build_object('packet_key',pkey,'source_device_id',src));
  else
    if incident_row.institution_id is not null and actor_institution is distinct from incident_row.institution_id
       and not exists(select 1 from public.profiles p where p.id=p_actor_id and p.role in ('operator','super-admin')) then
      raise exception 'Relay packet belongs to another institution';
    end if;
  end if;

  insert into public.relay_packets(
    packet_key,incident_id,source_device_id,relay_device_id,hop_count,max_hops,ttl_expires_at,status,
    packet_hash,minimal_payload,received_at,source_public_key,relay_public_key,signature,signed_payload,
    transport,received_by_device_id
  ) values(
    pkey,incident_uuid,left(src,160),left(relay,160),hops,maxh,expires,'received',phash,mp,now(),
    left(src_key,4096),left(relay_key,4096),left(coalesce(p_packet->>'source_signature',p_packet->>'signature'),4096),
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

-- Atomic payment/subscription settlement. The webhook inbox is marked processed only
-- after all state changes succeed; a retry remains safe while processed_at is null.
create or replace function public.process_bmoni_webhook_event(
  p_event_id text,
  p_proposal_id text,
  p_provider_transaction_id text,
  p_status text,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  ev public.bmoni_webhook_events;
  tx public.bmoni_transactions;
  pay public.payments;
  sub public.subscriptions;
  mapped_payment text;
  period_start date := current_date;
  period_end date;
begin
  select * into ev from public.bmoni_webhook_events where event_id=p_event_id for update;
  if not found then raise exception 'Webhook inbox event not found'; end if;
  if ev.processed_at is not null then return jsonb_build_object('processed',true,'duplicate',true); end if;

  if lower(coalesce(p_status,'')) not in ('successful','completed','failed','reversed') then
    update public.bmoni_webhook_events set processing_error=null, processed_at=now() where id=ev.id;
    return jsonb_build_object('processed',true,'ignored',true);
  end if;

  mapped_payment := case lower(p_status)
    when 'successful' then 'paid'
    when 'completed' then 'paid'
    when 'failed' then 'failed'
    when 'reversed' then 'cancelled'
  end;

  if nullif(trim(p_proposal_id),'') is not null then
    select * into tx from public.bmoni_transactions where proposal_id=trim(p_proposal_id) for update;
  elsif nullif(trim(p_provider_transaction_id),'') is not null then
    select * into tx from public.bmoni_transactions where bmoni_transaction_id=trim(p_provider_transaction_id) for update;
  end if;
  if tx.id is null then raise exception 'BMONI transaction not found for webhook'; end if;

  update public.bmoni_transactions set
    bmoni_transaction_id=coalesce(nullif(trim(p_provider_transaction_id),''),bmoni_transaction_id),
    status=case lower(p_status) when 'successful' then 'successful' when 'completed' then 'successful' when 'failed' then 'failed' when 'reversed' then 'reversed' else status end,
    raw_response=coalesce(p_payload,'{}'::jsonb),
    updated_at=now()
  where id=tx.id;

  if tx.payment_id is not null then
    update public.payments set status=mapped_payment, paid_at=case when mapped_payment='paid' then coalesce(paid_at,now()) else paid_at end
    where id=tx.payment_id returning * into pay;
  end if;

  if tx.subscription_id is not null then
    select * into sub from public.subscriptions where id=tx.subscription_id for update;
    if mapped_payment='paid' then
      period_end := greatest(coalesce(sub.current_period_end, current_date), current_date) + 30;
      update public.subscriptions set status='active', current_period_start=period_start, current_period_end=period_end,
        provider='BMONI Embedded', provider_reference=coalesce(nullif(trim(p_proposal_id),''),nullif(trim(p_provider_transaction_id),'')), updated_at=now()
      where id=sub.id;
    elsif lower(p_status)='reversed' then
      update public.subscriptions set status='past_due', provider='BMONI Embedded',
        provider_reference=coalesce(nullif(trim(p_proposal_id),''),nullif(trim(p_provider_transaction_id),'')), updated_at=now()
      where id=sub.id;
    end if;
  end if;

  update public.bmoni_webhook_events set processed_at=now(), processing_error=null where id=ev.id;
  return jsonb_build_object('processed',true,'transaction_id',tx.id,'payment_status',mapped_payment);
exception when others then
  update public.bmoni_webhook_events set processing_error=left(sqlerrm,1000) where event_id=p_event_id and processed_at is null;
  raise;
end;
$$;
revoke all on function public.process_bmoni_webhook_event(text,text,text,text,jsonb) from public;
grant execute on function public.process_bmoni_webhook_event(text,text,text,text,jsonb) to service_role;

-- Payment amount/currency are already server-owned; this index makes accidental
-- duplicate provider references detectable without changing the existing contract.
create unique index if not exists bmoni_transactions_provider_reference_unique
on public.bmoni_transactions(proposal_id)
where proposal_id is not null;
