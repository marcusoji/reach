-- REACH 0008: final source-level hardening reconstructed from the 0007 baseline.
-- Apply after 0001..0007.
-- Covers relay ownership/tenant binding, safe offline IDs, fixed TTL ceilings,
-- monotonic BMONI state transitions, and prevention of concurrent active institution payments.

-- -----------------------------------------------------------------------------
-- Relay device registration: never transfer an existing device to another user.
-- Same-owner re-registration is allowed only when the public key is unchanged.
-- -----------------------------------------------------------------------------
create or replace function public.register_my_relay_device(
  p_device_id text,
  p_public_key text,
  p_platform text default 'android',
  p_metadata jsonb default '{}'::jsonb
) returns public.device_registrations
language plpgsql security definer set search_path=public
as $$
declare
  d public.device_registrations;
  normalized_device text := left(trim(coalesce(p_device_id,'')),160);
  normalized_key text := trim(coalesce(p_public_key,''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(normalized_device) < 8 or length(normalized_key) < 40 then raise exception 'Invalid device identity'; end if;

  select * into d from public.device_registrations where device_id=normalized_device for update;
  if found then
    if d.user_id <> auth.uid() then
      raise exception 'Device identity is already registered to another account';
    end if;
    if d.public_key is distinct from normalized_key then
      raise exception 'Public-key rotation requires device re-enrollment';
    end if;

    update public.device_registrations
    set platform=left(coalesce(p_platform,'android'),40),
        status='active',
        last_seen_at=now(),
        metadata=coalesce(p_metadata,'{}'::jsonb),
        updated_at=now()
    where id=d.id
    returning * into d;
    return d;
  end if;

  insert into public.device_registrations(
    user_id,device_id,public_key,key_algorithm,platform,status,last_seen_at,metadata,updated_at
  ) values(
    auth.uid(),normalized_device,normalized_key,'ECDSA-P256-SHA256',left(coalesce(p_platform,'android'),40),
    'active',now(),coalesce(p_metadata,'{}'::jsonb),now()
  ) returning * into d;

  return d;
exception
  when unique_violation then
    raise exception 'Device identity is already registered';
end;
$$;
revoke all on function public.register_my_relay_device(text,text,text,jsonb) from public;
grant execute on function public.register_my_relay_device(text,text,text,jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Trusted relay ingestion.
-- The Edge Function verifies the actual ECDSA signature and packet hash before
-- calling this service function. This function enforces database-side identity,
-- tenant binding, safe UUID handling and transport limits as a second boundary.
-- -----------------------------------------------------------------------------
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
  select * into existing from public.relay_packets where packet_key=pkey for update;
  if found then return existing; end if;

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

-- -----------------------------------------------------------------------------
-- BMONI: prevent two simultaneous institutional subscription payments.
-- Failed/cancelled/reversed transactions do not block a new attempt.
-- -----------------------------------------------------------------------------
create unique index if not exists bmoni_one_active_subscription_payment
on public.bmoni_transactions(institution_id, subscription_id)
where subscription_id is not null and status in ('initiated','pending');

-- -----------------------------------------------------------------------------
-- BMONI: monotonic state machine. A late failure cannot downgrade a successful
-- transaction. Reversal remains the explicit terminal correction.
-- -----------------------------------------------------------------------------
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
  normalized_status text := lower(trim(coalesce(p_status,'')));
  next_tx_status text;
  next_payment_status text;
  current_tx_status text;
  current_payment_status text;
  period_start date := current_date;
  period_end date;
begin
  select * into ev from public.bmoni_webhook_events where event_id=p_event_id for update;
  if not found then raise exception 'Webhook inbox event not found'; end if;
  if ev.processed_at is not null then return jsonb_build_object('processed',true,'duplicate',true); end if;

  if normalized_status not in ('successful','completed','failed','reversed') then
    update public.bmoni_webhook_events set processing_error=null,processed_at=now() where id=ev.id;
    return jsonb_build_object('processed',true,'ignored',true);
  end if;

  if nullif(trim(p_proposal_id),'') is not null then
    select * into tx from public.bmoni_transactions where proposal_id=trim(p_proposal_id) for update;
  elsif nullif(trim(p_provider_transaction_id),'') is not null then
    select * into tx from public.bmoni_transactions where bmoni_transaction_id=trim(p_provider_transaction_id) for update;
  end if;
  if tx.id is null then raise exception 'BMONI transaction not found for webhook'; end if;

  current_tx_status := tx.status;
  next_tx_status := case
    when normalized_status in ('successful','completed') then 'successful'
    when normalized_status='reversed' then 'reversed'
    when normalized_status='failed' and current_tx_status in ('successful','reversed') then current_tx_status
    else 'failed'
  end;

  update public.bmoni_transactions set
    bmoni_transaction_id=coalesce(nullif(trim(p_provider_transaction_id),''),bmoni_transaction_id),
    status=next_tx_status,
    raw_response=coalesce(p_payload,'{}'::jsonb),
    failure_reason=case when normalized_status='failed' and next_tx_status='failed' then left(coalesce(p_payload->>'message','Provider reported failure'),500) else failure_reason end,
    updated_at=now()
  where id=tx.id;

  if tx.payment_id is not null then
    select status into current_payment_status from public.payments where id=tx.payment_id for update;
    next_payment_status := case
      when normalized_status in ('successful','completed') then 'paid'
      when normalized_status='reversed' then 'cancelled'
      when normalized_status='failed' and current_payment_status='paid' then 'paid'
      when normalized_status='failed' and current_payment_status='cancelled' then 'cancelled'
      else 'failed'
    end;

    update public.payments set
      status=next_payment_status,
      paid_at=case when next_payment_status='paid' then coalesce(paid_at,now()) else paid_at end
    where id=tx.payment_id returning * into pay;
  end if;

  if tx.subscription_id is not null then
    select * into sub from public.subscriptions where id=tx.subscription_id for update;
    if normalized_status in ('successful','completed') then
      period_end := greatest(coalesce(sub.current_period_end,current_date),current_date) + 30;
      update public.subscriptions set status='active',current_period_start=period_start,current_period_end=period_end,
        provider='BMONI Embedded',provider_reference=coalesce(nullif(trim(p_proposal_id),''),nullif(trim(p_provider_transaction_id),'')),updated_at=now()
      where id=sub.id;
    elsif normalized_status='reversed' then
      update public.subscriptions set status='past_due',provider='BMONI Embedded',
        provider_reference=coalesce(nullif(trim(p_proposal_id),''),nullif(trim(p_provider_transaction_id),'')),updated_at=now()
      where id=sub.id;
    elsif normalized_status='failed' and sub.status='trial' then
      update public.subscriptions set status='trial',updated_at=now() where id=sub.id;
    end if;
  end if;

  update public.bmoni_webhook_events set processed_at=now(),processing_error=null where id=ev.id;
  return jsonb_build_object('processed',true,'transaction_id',tx.id,'transaction_status',next_tx_status,'payment_status',next_payment_status);
exception when others then
  update public.bmoni_webhook_events set processing_error=left(sqlerrm,1000) where event_id=p_event_id and processed_at is null;
  raise;
end;
$$;
revoke all on function public.process_bmoni_webhook_event(text,text,text,text,jsonb) from public;
grant execute on function public.process_bmoni_webhook_event(text,text,text,text,jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- Helpful indexes for queue/replay cleanup.
-- -----------------------------------------------------------------------------
create index if not exists relay_packets_expiry_status_idx
on public.relay_packets(status,ttl_expires_at);
create index if not exists bmoni_webhook_unprocessed_idx
on public.bmoni_webhook_events(created_at)
where processed_at is null;
