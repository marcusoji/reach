create extension if not exists pgcrypto;
create extension if not exists postgis;

create type public.reach_role as enum ('citizen','security-desk','staff','institution','operator','super-admin');
create type public.incident_status as enum ('reported','received','verifying','verified','assigned','responding','on_scene','resolved','closed','cancelled');
create type public.incident_priority as enum ('low','medium','high','critical');
create type public.incident_category as enum ('medical','fire','security','accident','other');
create type public.channel_type as enum ('pwa','web','ussd','sms','voice','ivr','relay','human-relay','operator');

create table public.institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'community',
  city text,
  address text,
  timezone text not null default 'Africa/Lagos',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'REACH User',
  phone text,
  role public.reach_role not null default 'citizen',
  institution_id uuid references public.institutions(id) on delete set null,
  zone_id uuid,
  avatar_url text,
  relay_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  name text not null,
  landmark text,
  centroid geography(point,4326),
  created_at timestamptz not null default now()
);

alter table public.profiles add constraint profiles_zone_fk foreign key (zone_id) references public.zones(id) on delete set null;

create table public.institution_members (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  membership_role public.reach_role not null default 'citizen',
  status text not null default 'active' check (status in ('active','invited','suspended')),
  joined_at timestamptz not null default now(),
  unique(institution_id,user_id)
);

create table public.responders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  institution_id uuid not null references public.institutions(id) on delete cascade,
  responder_type text not null default 'staff',
  duty_status text not null default 'off_duty' check (duty_status in ('on_duty','on_task','off_duty')),
  current_location geography(point,4326),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id,institution_id)
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('REACH-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  institution_id uuid references public.institutions(id) on delete set null,
  reporter_id uuid references public.profiles(id) on delete set null,
  category public.incident_category not null,
  status public.incident_status not null default 'reported',
  priority public.incident_priority not null default 'high',
  title text not null,
  description text,
  source_channel public.channel_type not null default 'pwa',
  delivery_method text,
  location_label text,
  location_source text check (location_source is null or location_source in ('gps','network','registered','manual','zone','human-relay')),
  location_accuracy_m numeric,
  location geography(point,4326),
  location_context jsonb not null default '{}'::jsonb,
  ai_confidence numeric(5,2) check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 100)),
  ai_fp_code text,
  verification_state text not null default 'unverified' check (verification_state in ('unverified','pending','verified','rejected')),
  auto_pushed boolean not null default false,
  via_relay boolean not null default false,
  external_reference text,
  idempotency_key text,
  reported_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(reporter_id,idempotency_key)
);

create table public.incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  from_status public.incident_status,
  to_status public.incident_status,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.incident_assignments (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  responder_id uuid not null references public.responders(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  status text not null default 'assigned' check (status in ('assigned','accepted','declined','responding','on_scene','completed')),
  assigned_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz
);

create table public.incident_evidence (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  evidence_type text not null check (evidence_type in ('image','audio','video','sensor','text','location','relay')),
  storage_path text,
  content_hash text,
  source text,
  confidence numeric(5,2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.ai_assessments (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  model_name text not null,
  category public.incident_category,
  confidence numeric(5,2),
  fp_code text,
  evidence_ids uuid[] not null default '{}',
  explanation text,
  decision text not null default 'assist' check (decision in ('assist','recommend','auto_push','reject')),
  created_at timestamptz not null default now()
);

create table public.relay_packets (
  id uuid primary key default gen_random_uuid(),
  packet_key text not null unique,
  incident_id uuid references public.incidents(id) on delete cascade,
  source_device_id text,
  relay_device_id text,
  gateway_id text,
  hop_count integer not null default 0 check (hop_count >= 0),
  max_hops integer not null default 6 check (max_hops between 1 and 12),
  ttl_expires_at timestamptz not null default (now() + interval '30 minutes'),
  status text not null default 'queued' check (status in ('queued','received','forwarded','delivered','expired','rejected')),
  packet_hash text not null,
  minimal_payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  forwarded_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.device_registrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  device_id text not null unique,
  platform text,
  push_token text,
  relay_enabled boolean not null default true,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  phone text not null,
  relationship text,
  notify_on_incident boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  institution_id uuid references public.institutions(id) on delete cascade,
  incident_id uuid references public.incidents(id) on delete cascade,
  channel text not null check (channel in ('in_app','push','sms','email','voice')),
  title text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued','sent','delivered','failed','read')),
  provider_reference text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz
);

create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid references public.institutions(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  title text not null,
  body text not null,
  priority public.incident_priority not null default 'medium',
  channels text[] not null default '{in_app}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  plan_name text not null default 'REACH Full',
  status text not null default 'trial' check (status in ('trial','active','past_due','cancelled')),
  member_limit integer,
  current_period_start date,
  current_period_end date,
  provider text,
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'NGN',
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  provider text,
  provider_reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  institution_id uuid references public.institutions(id) on delete set null,
  action text not null,
  resource_type text,
  resource_id uuid,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index incidents_institution_status_idx on public.incidents(institution_id,status,priority,reported_at desc);
create index incidents_reporter_idx on public.incidents(reporter_id,reported_at desc);
create index incident_events_incident_idx on public.incident_events(incident_id,created_at desc);
create index relay_packets_status_idx on public.relay_packets(status,ttl_expires_at);
create index notifications_user_idx on public.notifications(user_id,status,created_at desc);
create index audit_logs_created_idx on public.audit_logs(created_at desc);

create or replace function public.current_reach_role()
returns public.reach_role language sql stable security definer set search_path=public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_institution_id()
returns uuid language sql stable security definer set search_path=public as $$
  select institution_id from public.profiles where id = auth.uid();
$$;

create or replace function public.has_reach_role(roles public.reach_role[])
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(public.current_reach_role() = any(roles), false);
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create trigger institutions_updated_at before update on public.institutions for each row execute procedure public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
create trigger incidents_updated_at before update on public.incidents for each row execute procedure public.set_updated_at();
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute procedure public.set_updated_at();
create trigger device_updated_at before update on public.device_registrations for each row execute procedure public.set_updated_at();

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

create trigger protect_profile_privileges before update on public.profiles for each row execute procedure public.protect_profile_privileges();

create or replace function public.create_institution_for_current_user(p_name text, p_category text default 'community', p_city text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare institution_uuid uuid;
begin
  if auth.uid() is null or public.current_reach_role() <> 'institution' then raise exception 'Institution role required'; end if;
  insert into public.institutions(name,category,city) values(p_name,p_category,p_city) returning id into institution_uuid;
  update public.profiles set institution_id=institution_uuid where id=auth.uid();
  insert into public.institution_members(institution_id,user_id,membership_role) values(institution_uuid,auth.uid(),'institution');
  insert into public.subscriptions(institution_id,plan_name,status) values(institution_uuid,'REACH Full','trial');
  return institution_uuid;
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id, full_name, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name','REACH User'),
    new.raw_user_meta_data->>'phone',
    'citizen'::public.reach_role
  ) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.institutions enable row level security;
alter table public.profiles enable row level security;
alter table public.zones enable row level security;
alter table public.institution_members enable row level security;
alter table public.responders enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_events enable row level security;
alter table public.incident_assignments enable row level security;
alter table public.incident_evidence enable row level security;
alter table public.ai_assessments enable row level security;
alter table public.relay_packets enable row level security;
alter table public.device_registrations enable row level security;
alter table public.emergency_contacts enable row level security;
alter table public.notifications enable row level security;
alter table public.broadcasts enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_self_select on public.profiles for select using (id=auth.uid() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy profiles_self_update on public.profiles for update using (id=auth.uid());
create policy institutions_member_select on public.institutions for select using (id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy zones_member_select on public.zones for select using (institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy members_select on public.institution_members for select using (institution_id=public.current_institution_id() or user_id=auth.uid() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy responders_select on public.responders for select using (institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));

create policy incidents_select on public.incidents for select using (
  reporter_id=auth.uid() or institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[])
);
create policy incidents_insert on public.incidents for insert with check (
  reporter_id=auth.uid() and (institution_id=public.current_institution_id() or institution_id is null)
);
create policy incidents_update on public.incidents for update using (false) with check (false);

create policy incident_events_select on public.incident_events for select using (exists(select 1 from public.incidents i where i.id=incident_id and (i.reporter_id=auth.uid() or i.institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]))));
create policy incident_events_insert on public.incident_events for insert with check (false);
create policy assignments_select on public.incident_assignments for select using (exists(select 1 from public.incidents i where i.id=incident_id and (i.reporter_id=auth.uid() or i.institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]))));
create policy assignments_manage on public.incident_assignments for all using (false) with check (false);
create policy evidence_select on public.incident_evidence for select using (exists(select 1 from public.incidents i where i.id=incident_id and (i.reporter_id=auth.uid() or i.institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]))));
create policy evidence_insert on public.incident_evidence for insert with check (false);
create policy ai_select on public.ai_assessments for select using (exists(select 1 from public.incidents i where i.id=incident_id and (i.reporter_id=auth.uid() or i.institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]))));
create policy relay_insert on public.relay_packets for insert with check (false);
create policy relay_select on public.relay_packets for select using (false);
create policy devices_select_self on public.device_registrations for select using (user_id=auth.uid() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy devices_insert_self on public.device_registrations for insert with check (user_id=auth.uid());
create policy devices_update_self on public.device_registrations for update using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy devices_delete_self on public.device_registrations for delete using (user_id=auth.uid());
create policy contacts_self on public.emergency_contacts for all using (user_id=auth.uid());
create policy notifications_self on public.notifications for select using (user_id=auth.uid() or institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy notifications_insert on public.notifications for insert with check (false);
create policy broadcasts_member_select on public.broadcasts for select using (institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy subscriptions_admin_select on public.subscriptions for select using (institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy payments_admin_select on public.payments for select using (institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[]));
create policy audit_operator_select on public.audit_logs for select using (public.has_reach_role(array['operator','super-admin']::public.reach_role[]));

create or replace function public.record_incident_event()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' then
    insert into public.incident_events(incident_id,actor_id,event_type,to_status,message)
    values(new.id,auth.uid(),'incident_created',new.status,'Incident created');
  elsif old.status is distinct from new.status then
    insert into public.incident_events(incident_id,actor_id,event_type,from_status,to_status,message)
    values(new.id,auth.uid(),'status_changed',old.status,new.status,concat('Status changed to ',replace(new.status::text,'_',' ')));
  end if;
  return new;
end $$;
create trigger incident_event_trigger after insert or update of status on public.incidents for each row execute procedure public.record_incident_event();

create or replace function public.expire_relay_packets()
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  update public.relay_packets set status='expired' where status in ('queued','received','forwarded') and ttl_expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

insert into public.institutions(name,category,city) values ('Greenfield Estate','estate','Abraka') on conflict do nothing;
