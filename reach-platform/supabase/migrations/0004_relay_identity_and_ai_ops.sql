-- REACH relay identity + AI operations hardening
-- Physical relay packets are authenticated before ingestion. AI remains advisory.

alter table public.device_registrations
  add column if not exists public_key text,
  add column if not exists key_algorithm text not null default 'ECDSA-P256-SHA256',
  add column if not exists status text not null default 'active' check (status in ('active','revoked','blocked')),
  add column if not exists last_relay_at timestamptz;

create unique index if not exists device_public_key_uidx on public.device_registrations(public_key) where public_key is not null;
create index if not exists device_status_seen_idx on public.device_registrations(status,last_seen_at desc);

alter table public.relay_packets
  add column if not exists source_public_key text,
  add column if not exists relay_public_key text,
  add column if not exists signature text,
  add column if not exists signed_payload text,
  add column if not exists transport text,
  add column if not exists received_by_device_id text;

create index if not exists relay_transport_idx on public.relay_packets(transport,status,created_at desc);

create or replace function public.register_my_relay_device(
  p_device_id text,
  p_public_key text,
  p_platform text default 'android',
  p_metadata jsonb default '{}'::jsonb
) returns public.device_registrations
language plpgsql security definer set search_path=public
as $$
declare d public.device_registrations;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_device_id,''))) < 8 or length(trim(coalesce(p_public_key,''))) < 40 then raise exception 'Invalid device identity'; end if;
  insert into public.device_registrations(user_id,device_id,public_key,key_algorithm,platform,status,last_seen_at,metadata,updated_at)
  values(auth.uid(),left(trim(p_device_id),160),trim(p_public_key),'ECDSA-P256-SHA256',left(coalesce(p_platform,'android'),40),'active',now(),coalesce(p_metadata,'{}'::jsonb),now())
  on conflict(device_id) do update set
    user_id=excluded.user_id,
    public_key=excluded.public_key,
    key_algorithm=excluded.key_algorithm,
    platform=excluded.platform,
    status='active',
    last_seen_at=now(),
    metadata=excluded.metadata,
    updated_at=now()
  returning * into d;
  return d;
end; $$;

revoke all on function public.register_my_relay_device(text,text,text,jsonb) from public;
grant execute on function public.register_my_relay_device(text,text,text,jsonb) to authenticated;

create or replace function public.authorize_relay_source(p_device_id text, p_public_key text)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists(
    select 1 from public.device_registrations d
    where d.device_id=trim(p_device_id)
      and d.public_key=trim(p_public_key)
      and d.status='active'
  );
$$;
revoke all on function public.authorize_relay_source(text,text) from public;
grant execute on function public.authorize_relay_source(text,text) to authenticated;

create or replace function public.ingest_authenticated_relay_packet(p_packet jsonb)
returns public.relay_packets
language plpgsql security definer set search_path=public
as $$
declare r public.relay_packets; incident_inst uuid; hops int; maxh int; expires timestamptz; pkey text; phash text; src text; src_key text; relay text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
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
  if incident_inst is not null and public.current_institution_id() is distinct from incident_inst and not public.has_reach_role(array['operator','super-admin']::public.reach_role[]) then raise exception 'Relay packet belongs to another institution'; end if;
  insert into public.relay_packets(packet_key,incident_id,source_device_id,relay_device_id,hop_count,max_hops,ttl_expires_at,status,packet_hash,minimal_payload,received_at,source_public_key,relay_public_key,signature,signed_payload,transport,received_by_device_id)
  values(pkey,(p_packet->>'incident_id')::uuid,left(src,160),left(relay,160),hops,maxh,expires,'received',phash,coalesce(p_packet->'minimal_payload','{}'::jsonb),now(),left(src_key,4096),left(p_packet->>'relay_public_key',4096),left(p_packet->>'signature',4096),left(p_packet->>'signed_payload',12000),left(coalesce(p_packet->>'transport','unknown'),30),left(coalesce(p_packet->>'received_by_device_id',''),160))
  on conflict(packet_key) do update set relay_device_id=excluded.relay_device_id,relay_public_key=excluded.relay_public_key,status=case when public.relay_packets.status='delivered' then 'delivered' else 'received' end,received_at=now()
  returning * into r;
  update public.device_registrations set last_seen_at=now(),last_relay_at=now(),updated_at=now() where device_id=src and status='active';
  if relay is not null and relay<>'' then update public.device_registrations set last_seen_at=now(),last_relay_at=now(),updated_at=now() where device_id=relay and status='active'; end if;
  return r;
end; $$;

revoke all on function public.ingest_authenticated_relay_packet(jsonb) from public;
grant execute on function public.ingest_authenticated_relay_packet(jsonb) to authenticated;

create table if not exists public.ai_model_registry (
  id uuid primary key default gen_random_uuid(),
  model_name text not null unique,
  provider text not null,
  modality text[] not null default '{}',
  version text not null,
  status text not null default 'active' check (status in ('active','shadow','disabled')),
  calibration_version text,
  latency_target_ms integer,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references public.incidents(id) on delete cascade,
  assessment_id uuid references public.ai_assessments(id) on delete cascade,
  outcome text check (outcome in ('confirmed','false_positive','false_negative','uncertain','not_reviewed')) default 'not_reviewed',
  reviewer_id uuid references public.profiles(id),
  notes text,
  created_at timestamptz not null default now()
);

alter table public.ai_model_registry enable row level security;
alter table public.ai_evaluations enable row level security;
create policy ai_registry_select_ops on public.ai_model_registry for select using (public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy ai_eval_select_ops on public.ai_evaluations for select using (public.has_reach_role(array['operator','super-admin']::public.reach_role[]) or reviewer_id=auth.uid());
create policy ai_eval_insert_ops on public.ai_evaluations for insert with check (public.has_reach_role(array['operator','super-admin']::public.reach_role[]) and reviewer_id=auth.uid());

insert into public.ai_model_registry(model_name,provider,modality,version,status,calibration_version,latency_target_ms,metadata)
values
('REACH-Safety-Fusion','reach','{text,image,audio,sensor,location,corroboration}','2.0','active','baseline-v1',1200,'{"role":"deterministic_safety_fusion","human_review_required":true}'),
('REACH-Multimodal-Assist','external','{text,image,audio}','1.0','shadow','pending-field-calibration',5000,'{"role":"model_assist","human_review_required":true}')
on conflict(model_name) do nothing;
