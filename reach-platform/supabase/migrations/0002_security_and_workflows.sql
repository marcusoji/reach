-- REACH MVP hardening and workflow migration
-- Apply after 0001_reach_mvp.sql

create table if not exists public.institution_invites (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  email text not null,
  role public.reach_role not null check (role in ('staff','security-desk')),
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists institution_invites_lookup_idx on public.institution_invites(email, expires_at) where used_at is null;

alter table public.institution_invites enable row level security;

-- Never trust client signup metadata for privileges.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id, full_name, phone, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''),'REACH User'),
    new.raw_user_meta_data->>'phone',
    'citizen'::public.reach_role
  ) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

drop function if exists public.create_institution_for_current_user(text,text,text);

-- A citizen may create their own institution account atomically; this is the only
-- normal self-service promotion path and cannot create operator/super-admin access.
create or replace function public.create_institution_for_current_user(
  p_name text,
  p_category text default 'community',
  p_city text default null,
  p_address text default null
)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  institution_uuid uuid;
  existing_institution uuid;
  current_role public.reach_role;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role, institution_id into current_role, existing_institution from public.profiles where id=auth.uid() for update;
  if current_role <> 'citizen' or existing_institution is not null then raise exception 'Institution account cannot be created from this account'; end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Institution name is required'; end if;

  insert into public.institutions(name,category,city,address)
  values(trim(p_name),coalesce(nullif(trim(p_category),''),'community'),nullif(trim(p_city),''),nullif(trim(p_address),''))
  returning id into institution_uuid;

  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles
  set institution_id=institution_uuid, role='institution'
  where id=auth.uid();

  insert into public.institution_members(institution_id,user_id,membership_role)
  values(institution_uuid,auth.uid(),'institution');

  insert into public.subscriptions(institution_id,plan_name,status)
  values(institution_uuid,'REACH Full','trial');

  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),institution_uuid,'institution.created','institution',institution_uuid,jsonb_build_object('source','self_service'));

  return institution_uuid;
end $$;

-- Invite management. Codes are stored only as SHA-256 hashes.
create or replace function public.create_staff_invite(
  p_email text,
  p_role public.reach_role,
  p_expires_hours integer default 72
)
returns text language plpgsql security definer set search_path=public as $$
declare
  p_role_allowed boolean;
  inst uuid;
  raw_code text;
  hashed text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.current_reach_role() not in ('institution','operator','super-admin') then raise exception 'Not permitted'; end if;
  inst := public.current_institution_id();
  if inst is null and public.current_reach_role()='institution' then raise exception 'Institution account is not configured'; end if;
  if p_role not in ('staff','security-desk') then raise exception 'Invalid invite role'; end if;
  if length(trim(coalesce(p_email,''))) < 3 then raise exception 'Email is required'; end if;
  if p_expires_hours < 1 or p_expires_hours > 168 then raise exception 'Invalid expiry'; end if;
  if public.current_reach_role() in ('operator','super-admin') and inst is null then
    raise exception 'Operator must specify institution through an administrative workflow';
  end if;

  raw_code := 'REACH-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  hashed := encode(digest(raw_code,'sha256'),'hex');
  insert into public.institution_invites(institution_id,email,role,code_hash,expires_at,created_by)
  values(inst,lower(trim(p_email)),p_role,hashed,now() + make_interval(hours=>p_expires_hours),auth.uid());
  return raw_code;
end $$;

create or replace function public.redeem_staff_invite(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  inv public.institution_invites%rowtype;
  current_role public.reach_role;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role into current_role from public.profiles where id=auth.uid() for update;
  if current_role <> 'citizen' then raise exception 'Account is already assigned a role'; end if;
  select * into inv from public.institution_invites
  where code_hash=encode(digest(trim(p_code),'sha256'),'hex')
    and used_at is null and expires_at > now()
    and lower(email)=lower(coalesce((select email from auth.users where id=auth.uid()),''))
  for update;
  if not found then raise exception 'Invalid, expired, used, or email-mismatched invite'; end if;

  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles set role=inv.role,institution_id=inv.institution_id where id=auth.uid();
  insert into public.institution_members(institution_id,user_id,membership_role)
  values(inv.institution_id,auth.uid(),inv.role)
  on conflict(institution_id,user_id) do update set membership_role=excluded.membership_role,status='active';
  update public.institution_invites set used_at=now() where id=inv.id;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id)
  values(auth.uid(),inv.institution_id,'membership.invite_redeemed','institution_member',auth.uid());

  select jsonb_build_object('role',role,'institution_id',institution_id) into result from public.profiles where id=auth.uid();
  return result;
end $$;

-- Incident creation: institution is derived from the authenticated profile unless
-- a platform operator is acting. This prevents cross-tenant injection.
create or replace function public.create_incident_for_current_user(p_payload jsonb, p_idempotency_key text)
returns public.incidents language plpgsql security definer set search_path=public as $$
declare
  p public.profiles%rowtype;
  target_institution uuid;
  existing public.incidents;
  created public.incidents;
  requested_priority public.incident_priority;
  requested_category public.incident_category;
  requested_channel public.channel_type;
  location geography(point,4326);
  lat numeric;
  lng numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into p from public.profiles where id=auth.uid();
  if not found then raise exception 'Profile not found'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then raise exception 'Valid idempotency key required'; end if;

  select * into existing from public.incidents where reporter_id=auth.uid() and idempotency_key=p_idempotency_key limit 1;
  if found then return existing; end if;

  target_institution := p.institution_id;
  if public.current_reach_role() in ('operator','super-admin') and nullif(p_payload->>'institution_id','') is not null then
    target_institution := (p_payload->>'institution_id')::uuid;
  elsif nullif(p_payload->>'institution_id','') is not null and (p_payload->>'institution_id')::uuid is distinct from p.institution_id then
    raise exception 'Cannot submit an incident for another institution';
  end if;

  requested_category := coalesce(nullif(p_payload->>'category','')::public.incident_category,'other');
  requested_priority := coalesce(nullif(p_payload->>'priority','')::public.incident_priority,'high');
  requested_channel := coalesce(nullif(p_payload->>'source_channel','')::public.channel_type,'pwa');

  if p_payload ? 'latitude' and p_payload ? 'longitude' then
    lat := (p_payload->>'latitude')::numeric; lng := (p_payload->>'longitude')::numeric;
    if lat between -90 and 90 and lng between -180 and 180 then location := ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography; end if;
  end if;

  insert into public.incidents(
    institution_id,reporter_id,category,title,description,priority,source_channel,delivery_method,
    location_label,location_source,location_accuracy_m,location,location_context,ai_confidence,ai_fp_code,
    verification_state,via_relay,idempotency_key
  ) values (
    target_institution,auth.uid(),requested_category,
    coalesce(nullif(trim(p_payload->>'title'),''),initcap(requested_category::text)||' emergency'),
    nullif(trim(p_payload->>'description'),''),requested_priority,requested_channel,
    coalesce(nullif(p_payload->>'delivery_method',''),'internet'),nullif(trim(p_payload->>'location_label'),''),
    nullif(p_payload->>'location_source',''),nullif(p_payload->>'location_accuracy_m','')::numeric,location,
    coalesce(p_payload->'location_context','{}'::jsonb),nullif(p_payload->>'ai_confidence','')::numeric,
    nullif(p_payload->>'ai_fp_code',''),coalesce((p_payload->>'verification_state'),'unverified'),
    coalesce((p_payload->>'via_relay')::boolean,false),p_idempotency_key
  ) returning * into created;

  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),created.institution_id,'incident.created','incident',created.id,jsonb_build_object('channel',created.source_channel));
  return created;
end $$;

create or replace function public.transition_incident(p_incident_id uuid, p_to public.incident_status, p_verification_state text default null)
returns public.incidents language plpgsql security definer set search_path=public as $$
declare
  i public.incidents%rowtype;
  r public.reach_role;
  allowed boolean := false;
  updated public.incidents;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into i from public.incidents where id=p_incident_id for update;
  if not found then raise exception 'Incident not found'; end if;
  r := public.current_reach_role();

  if r='citizen' then
    if i.reporter_id<>auth.uid() then raise exception 'Not permitted'; end if;
    allowed := p_to='cancelled' and i.status in ('reported','received','verifying');
  elsif r in ('security-desk','staff','institution') then
    if i.institution_id is null or i.institution_id<>public.current_institution_id() then raise exception 'Not permitted'; end if;
    allowed := (i.status,p_to) in (
      ('reported','received'),('reported','verifying'),('received','verifying'),('received','cancelled'),
      ('verifying','verified'),('verifying','reported'),('verifying','cancelled'),('verified','assigned'),
      ('verified','cancelled'),('assigned','responding'),('assigned','cancelled'),('responding','on_scene'),
      ('responding','assigned'),('responding','cancelled'),('on_scene','resolved'),('on_scene','responding'),
      ('resolved','closed')
    );
  else
    allowed := (i.status,p_to) in (
      ('reported','received'),('reported','verifying'),('received','verifying'),('received','cancelled'),
      ('verifying','verified'),('verifying','reported'),('verifying','cancelled'),('verified','assigned'),
      ('verified','cancelled'),('assigned','responding'),('assigned','cancelled'),('responding','on_scene'),
      ('responding','assigned'),('responding','cancelled'),('on_scene','resolved'),('on_scene','responding'),
      ('resolved','closed')
    );
  end if;
  if not allowed then raise exception 'Invalid incident transition: % -> %',i.status,p_to; end if;

  update public.incidents set status=p_to,
    verification_state=case when p_verification_state is not null then p_verification_state else verification_state end,
    acknowledged_at=case when p_to in ('received','verifying','verified','assigned','responding','on_scene','resolved','closed') and acknowledged_at is null then now() else acknowledged_at end,
    resolved_at=case when p_to='resolved' then now() else resolved_at end,
    closed_at=case when p_to='closed' then now() else closed_at end
  where id=p_incident_id returning * into updated;

  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),updated.institution_id,'incident.status_changed','incident',updated.id,jsonb_build_object('from',i.status,'to',updated.status));
  return updated;
end $$;

create or replace function public.assign_incident(p_incident_id uuid, p_responder_id uuid)
returns public.incident_assignments language plpgsql security definer set search_path=public as $$
declare
  i public.incidents%rowtype;
  r public.responders%rowtype;
  a public.incident_assignments;
  role_now public.reach_role;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  role_now := public.current_reach_role();
  if role_now not in ('security-desk','institution','operator','super-admin') then raise exception 'Not permitted'; end if;
  select * into i from public.incidents where id=p_incident_id for update;
  select * into r from public.responders where id=p_responder_id;
  if not found then raise exception 'Responder not found'; end if;
  if i.institution_id is null or r.institution_id<>i.institution_id then raise exception 'Cross-institution assignment denied'; end if;
  if role_now in ('security-desk','institution') and i.institution_id<>public.current_institution_id() then raise exception 'Not permitted'; end if;
  if i.status not in ('verified','assigned') then raise exception 'Incident must be verified before assignment'; end if;

  insert into public.incident_assignments(incident_id,responder_id,assigned_by)
  values(i.id,r.id,auth.uid()) returning * into a;
  update public.incidents set status='assigned' where id=i.id;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),i.institution_id,'incident.assigned','incident',i.id,jsonb_build_object('responder_id',r.id));
  return a;
end $$;

create or replace function public.ingest_relay_packet(p_packet jsonb)
returns public.relay_packets language plpgsql security definer set search_path=public as $$
declare
  incident_inst uuid;
  packet public.relay_packets;
  existing public.relay_packets;
  hops integer := greatest(coalesce((p_packet->>'hop_count')::integer,0),0);
  maxh integer := least(greatest(coalesce((p_packet->>'max_hops')::integer,6),1),12);
  expires timestamptz := coalesce(nullif(p_packet->>'ttl_expires_at','')::timestamptz,now()+interval '30 minutes');
  incident_uuid uuid := nullif(p_packet->>'incident_id','')::uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_packet->>'packet_key',''))) < 8 then raise exception 'Packet key required'; end if;
  if length(trim(coalesce(p_packet->>'packet_hash',''))) < 16 then raise exception 'Packet hash required'; end if;
  if hops > maxh or expires <= now() then raise exception 'Expired or invalid relay packet'; end if;

  if incident_uuid is not null then
    select institution_id into incident_inst from public.incidents where id=incident_uuid;
    if incident_inst is null then raise exception 'Incident not found'; end if;
    if public.current_institution_id() is distinct from incident_inst and public.current_reach_role() not in ('operator','super-admin') then
      raise exception 'Relay packet belongs to another institution';
    end if;
  end if;

  select * into existing from public.relay_packets where packet_key=p_packet->>'packet_key';
  if found then return existing; end if;

  insert into public.relay_packets(packet_key,incident_id,source_device_id,relay_device_id,gateway_id,hop_count,max_hops,ttl_expires_at,status,packet_hash,minimal_payload)
  values(p_packet->>'packet_key',incident_uuid,p_packet->>'source_device_id',p_packet->>'relay_device_id',p_packet->>'gateway_id',hops,maxh,expires,'received',p_packet->>'packet_hash',coalesce(p_packet->'minimal_payload','{}'::jsonb))
  returning * into packet;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),incident_inst,'relay.packet_received','relay_packet',packet.id,jsonb_build_object('hop_count',hops));
  return packet;
end $$;

create or replace function public.append_audit_log(p_action text,p_resource_type text default null,p_resource_id uuid default null,p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),public.current_institution_id(),p_action,p_resource_type,p_resource_id,coalesce(p_metadata,'{}'::jsonb));
end $$;

-- Replace broad client-write policies with read-only access; mutations go through
-- validated SECURITY DEFINER functions above.
drop policy if exists incidents_insert on public.incidents;
drop policy if exists incidents_update on public.incidents;
drop policy if exists incident_events_insert on public.incident_events;
drop policy if exists assignments_manage on public.incident_assignments;
drop policy if exists evidence_insert on public.incident_evidence;
drop policy if exists relay_insert on public.relay_packets;
drop policy if exists relay_select on public.relay_packets;
drop policy if exists notifications_insert on public.notifications;
drop policy if exists devices_self on public.device_registrations;
drop policy if exists devices_select_self on public.device_registrations;
drop policy if exists devices_insert_self on public.device_registrations;
drop policy if exists devices_update_self on public.device_registrations;
drop policy if exists devices_delete_self on public.device_registrations;


create policy relay_select_scoped on public.relay_packets for select using (
  exists(select 1 from public.incidents i where i.id=incident_id and (i.reporter_id=auth.uid() or i.institution_id=public.current_institution_id()))
  or public.has_reach_role(array['operator','super-admin']::public.reach_role[])
);
create policy devices_select_scoped on public.device_registrations for select using (user_id=auth.uid() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy devices_insert_self on public.device_registrations for insert with check (user_id=auth.uid());
create policy devices_update_self on public.device_registrations for update using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy devices_delete_self on public.device_registrations for delete using (user_id=auth.uid());

-- Notifications are system-created; users only read their own/institution notifications.
-- Broadcasts, subscriptions and payments remain read-only from client RLS.

revoke all on function public.create_staff_invite(text,public.reach_role,integer) from public;
revoke all on function public.redeem_staff_invite(text) from public;
revoke all on function public.create_institution_for_current_user(text,text,text,text) from public;
revoke all on function public.create_incident_for_current_user(jsonb,text) from public;
revoke all on function public.transition_incident(uuid,public.incident_status,text) from public;
revoke all on function public.assign_incident(uuid,uuid) from public;
revoke all on function public.ingest_relay_packet(jsonb) from public;
revoke all on function public.append_audit_log(text,text,uuid,jsonb) from public;
grant execute on function public.create_staff_invite(text,public.reach_role,integer) to authenticated;
grant execute on function public.redeem_staff_invite(text) to authenticated;
grant execute on function public.create_institution_for_current_user(text,text,text,text) to authenticated;
grant execute on function public.create_incident_for_current_user(jsonb,text) to authenticated;
grant execute on function public.transition_incident(uuid,public.incident_status,text) to authenticated;
grant execute on function public.assign_incident(uuid,uuid) to authenticated;
grant execute on function public.ingest_relay_packet(jsonb) to authenticated;
grant execute on function public.append_audit_log(text,text,uuid,jsonb) to authenticated;

-- Ensure privilege protection also covers direct profile updates.
create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and coalesce(current_setting('reach.allow_privilege_change', true),'off') <> 'on' then
    new.role := old.role;
    new.institution_id := old.institution_id;
    new.zone_id := old.zone_id;
  end if;
  return new;
end $$;

-- No client can directly insert audit records.
revoke insert, update, delete on public.audit_logs from anon, authenticated;

create or replace function public.transition_assignment(p_assignment_id uuid, p_status text)
returns public.incident_assignments language plpgsql security definer set search_path=public as $$
declare
  a public.incident_assignments%rowtype;
  r public.responders%rowtype;
  i public.incidents%rowtype;
  updated public.incident_assignments;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_status not in ('accepted','declined','responding','on_scene','completed') then raise exception 'Invalid assignment status'; end if;
  select * into a from public.incident_assignments where id=p_assignment_id for update;
  if not found then raise exception 'Assignment not found'; end if;
  select * into r from public.responders where id=a.responder_id;
  select * into i from public.incidents where id=a.incident_id for update;
  if r.user_id<>auth.uid() then raise exception 'Only the assigned responder can update this task'; end if;
  if i.institution_id<>public.current_institution_id() then raise exception 'Not permitted'; end if;
  if p_status='accepted' and a.status<>'assigned' then raise exception 'Task is not awaiting acceptance'; end if;
  if p_status='responding' and a.status not in ('assigned','accepted') then raise exception 'Task must be accepted first'; end if;
  if p_status='on_scene' and a.status<>'responding' then raise exception 'Responder must be responding first'; end if;
  if p_status='completed' and a.status<>'on_scene' then raise exception 'Responder must be on scene first'; end if;

  update public.incident_assignments set status=p_status,
    accepted_at=case when p_status='accepted' and accepted_at is null then now() else accepted_at end,
    completed_at=case when p_status='completed' then now() else completed_at end
  where id=a.id returning * into updated;

  if p_status='accepted' then update public.incidents set status='assigned' where id=i.id;
  elsif p_status='responding' then update public.incidents set status='responding' where id=i.id;
  elsif p_status='on_scene' then update public.incidents set status='on_scene' where id=i.id;
  elsif p_status='completed' then update public.incidents set status='resolved',resolved_at=now() where id=i.id;
  end if;

  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),i.institution_id,'assignment.status_changed','incident_assignment',a.id,jsonb_build_object('status',p_status));
  return updated;
end $$;
revoke all on function public.transition_assignment(uuid,text) from public;
grant execute on function public.transition_assignment(uuid,text) to authenticated;

create or replace function public.promote_current_user_to_operator()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.current_reach_role() <> 'citizen' or public.current_institution_id() is not null then raise exception 'Account is not eligible for operator provisioning'; end if;
  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles set role='operator' where id=auth.uid();
  insert into public.audit_logs(actor_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),'operator.provisioned','profile',auth.uid(),jsonb_build_object('source','server_provisioning_key'));
  select jsonb_build_object('id',id,'role',role,'institution_id',institution_id,'full_name',full_name) into result from public.profiles where id=auth.uid();
  return result;
end $$;
revoke all on function public.promote_current_user_to_operator() from public;
grant execute on function public.promote_current_user_to_operator() to authenticated;

create or replace function public.list_responder_directory()
returns table(id uuid,user_id uuid,institution_id uuid,full_name text,responder_type text,duty_status text,last_seen_at timestamptz)
language sql security definer set search_path=public as $$
  select r.id,r.user_id,r.institution_id,p.full_name,r.responder_type,r.duty_status,r.last_seen_at
  from public.responders r
  join public.profiles p on p.id=r.user_id
  where (
    r.institution_id=public.current_institution_id()
    or public.has_reach_role(array['operator','super-admin']::public.reach_role[])
  )
  order by r.duty_status,r.created_at;
$$;
revoke all on function public.list_responder_directory() from public;
grant execute on function public.list_responder_directory() to authenticated;

create table if not exists public.rate_limit_buckets (
  bucket_key text primary key,
  window_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.rate_limit_buckets enable row level security;

create or replace function public.check_reach_rate_limit(p_bucket_key text,p_limit integer default 60,p_window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  current_window timestamptz := date_trunc('second',now());
  bucket public.rate_limit_buckets%rowtype;
begin
  select * into bucket from public.rate_limit_buckets where bucket_key=p_bucket_key for update;
  if not found then
    insert into public.rate_limit_buckets(bucket_key,window_start,request_count) values(p_bucket_key,current_window,1);
    return true;
  end if;
  if bucket.window_start < now() - make_interval(secs=>p_window_seconds) then
    update public.rate_limit_buckets set window_start=current_window,request_count=1,updated_at=now() where bucket_key=p_bucket_key;
    return true;
  end if;
  if bucket.request_count >= p_limit then return false; end if;
  update public.rate_limit_buckets set request_count=request_count+1,updated_at=now() where bucket_key=p_bucket_key;
  return true;
end $$;
revoke all on function public.check_reach_rate_limit(text,integer,integer) from public;
grant execute on function public.check_reach_rate_limit(text,integer,integer) to authenticated;


-- Enable Supabase Realtime for operational incident updates. RLS still governs which
-- authenticated clients can receive rows.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='incidents') then
    alter publication supabase_realtime add table public.incidents;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='incident_assignments') then
    alter publication supabase_realtime add table public.incident_assignments;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception when undefined_object then
  -- The publication is not available on a non-Realtime/self-hosted installation.
  null;
end $$;

create or replace function public.add_responder(p_user_id uuid,p_responder_type text default 'staff')
returns public.responders language plpgsql security definer set search_path=public as $$
declare
  member_row public.institution_members%rowtype;
  created public.responders;
  inst uuid := public.current_institution_id();
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.current_reach_role() not in ('institution','security-desk') then raise exception 'Not permitted'; end if;
  if inst is null and public.current_reach_role() in ('institution','security-desk') then raise exception 'Institution is not configured'; end if;
  select * into member_row from public.institution_members where user_id=p_user_id and institution_id=inst and status='active';
  if not found then raise exception 'User is not an active member of this institution'; end if;
  insert into public.responders(user_id,institution_id,responder_type,duty_status)
  values(p_user_id,inst,coalesce(nullif(trim(p_responder_type),''),'staff'),'off_duty')
  on conflict(user_id,institution_id) do update set responder_type=excluded.responder_type
  returning * into created;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),inst,'responder.created','responder',created.id,jsonb_build_object('user_id',p_user_id));
  return created;
end $$;

create or replace function public.set_my_responder_status(p_status text)
returns public.responders language plpgsql security definer set search_path=public as $$
declare updated public.responders;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_status not in ('on_duty','off_duty') then raise exception 'Invalid duty status'; end if;
  update public.responders set duty_status=p_status,last_seen_at=now() where user_id=auth.uid() returning * into updated;
  if not found then raise exception 'Responder profile not found'; end if;
  return updated;
end $$;
revoke all on function public.add_responder(uuid,text) from public;
revoke all on function public.set_my_responder_status(text) from public;
grant execute on function public.add_responder(uuid,text) to authenticated;
grant execute on function public.set_my_responder_status(text) to authenticated;

create or replace function public.list_institution_member_directory()
returns table(user_id uuid,full_name text,role public.reach_role,status text)
language sql security definer set search_path=public as $$
  select m.user_id,p.full_name,m.membership_role,m.status
  from public.institution_members m join public.profiles p on p.id=m.user_id
  where m.institution_id=public.current_institution_id()
  order by p.full_name;
$$;
revoke all on function public.list_institution_member_directory() from public;
grant execute on function public.list_institution_member_directory() to authenticated;

create or replace function public.queue_incident_notifications()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.notifications(user_id,incident_id,channel,title,body,status)
  select c.user_id,new.id,'in_app','Emergency reported',
         'A REACH emergency was raised. Incident ' || new.code || ' is entering the response workflow.','queued'
  from public.emergency_contacts c
  where c.user_id=new.reporter_id and c.notify_on_incident=true;

  if new.institution_id is not null then
    insert into public.notifications(user_id,institution_id,incident_id,channel,title,body,status)
    select m.user_id,new.institution_id,new.id,'in_app','New REACH incident',
           new.code || ' · ' || initcap(new.category::text) || ' · ' || initcap(new.priority::text),'queued'
    from public.institution_members m
    where m.institution_id=new.institution_id and m.membership_role='security-desk' and m.status='active';
  end if;
  return new;
end $$;

drop trigger if exists incident_notification_trigger on public.incidents;
create trigger incident_notification_trigger after insert on public.incidents for each row execute procedure public.queue_incident_notifications();

alter table public.notifications add column if not exists recipient_phone text;
alter table public.notifications add column if not exists recipient_email text;

create or replace function public.queue_incident_notifications()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.notifications(user_id,incident_id,channel,title,body,status,recipient_phone)
  select c.user_id,new.id,'in_app','Emergency reported',
         'A REACH emergency was raised. Incident ' || new.code || ' is entering the response workflow.','queued',c.phone
  from public.emergency_contacts c
  where c.user_id=new.reporter_id and c.notify_on_incident=true;

  if new.institution_id is not null then
    insert into public.notifications(user_id,institution_id,incident_id,channel,title,body,status)
    select m.user_id,new.institution_id,new.id,'in_app','New REACH incident',
           new.code || ' · ' || initcap(new.category::text) || ' · ' || initcap(new.priority::text),'queued'
    from public.institution_members m
    where m.institution_id=new.institution_id and m.membership_role='security-desk' and m.status='active';
  end if;
  return new;
end $$;
