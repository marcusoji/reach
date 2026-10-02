-- REACH 0012: NULL-safe tenant comparisons in authorization RPCs.
--
-- Several SECURITY DEFINER RPCs scoped cross-tenant access with
-- `x.institution_id <> public.current_institution_id()`. When the caller's own
-- institution_id is NULL — an operator with no institution, or a staff/institution
-- account that somehow lost its institution — that comparison evaluates to NULL,
-- so `if <cond> then raise ...` does not fire and the guard is skipped entirely.
-- The same shape in create_institution_for_current_user let a NULL role pass the
-- `current_role <> 'citizen'` check.
--
-- Every path that creates such a caller currently sets a role/institution
-- (redeem_staff_invite always assigns one; protect_profile_privileges blocks
-- self-nulling), so this was latent rather than live. This migration makes the
-- comparisons NULL-safe so the guards hold regardless of profile anomalies.
--
-- IS DISTINCT FROM is the intent-preserving fix: it is true exactly when the two
-- values differ, and treats NULL as a comparable value rather than an unknown.

-- 1) transition_incident — the staff/institution branch must reject a NULL
--    caller institution, not fall through to the permissive operator branch.
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
    if i.reporter_id is distinct from auth.uid() then raise exception 'Not permitted'; end if;
    allowed := p_to='cancelled' and i.status in ('reported','received','verifying');
  elsif r in ('security-desk','staff','institution') then
    if i.institution_id is null or i.institution_id is distinct from public.current_institution_id() then raise exception 'Not permitted'; end if;
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
revoke all on function public.transition_incident(uuid,public.incident_status,text) from public;
grant execute on function public.transition_incident(uuid,public.incident_status,text) to authenticated;

-- 2) assign_incident — a NULL caller institution must not satisfy the
--    security-desk/institution scoping check.
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
  if i.institution_id is null or r.institution_id is distinct from i.institution_id then raise exception 'Cross-institution assignment denied'; end if;
  if role_now in ('security-desk','institution') and i.institution_id is distinct from public.current_institution_id() then raise exception 'Not permitted'; end if;
  if i.status not in ('verified','assigned') then raise exception 'Incident must be verified before assignment'; end if;

  insert into public.incident_assignments(incident_id,responder_id,assigned_by)
  values(i.id,r.id,auth.uid()) returning * into a;
  update public.incidents set status='assigned' where id=i.id;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),i.institution_id,'incident.assigned','incident',i.id,jsonb_build_object('responder_id',r.id));
  return a;
end $$;
revoke all on function public.assign_incident(uuid,uuid) from public;
grant execute on function public.assign_incident(uuid,uuid) to authenticated;

-- 3) transition_assignment — the same NULL-institution skip.
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
  if r.user_id is distinct from auth.uid() then raise exception 'Only the assigned responder can update this task'; end if;
  if i.institution_id is distinct from public.current_institution_id() then raise exception 'Not permitted'; end if;
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

-- 4) create_institution_for_current_user — a NULL role must not pass the
--    citizen-only check (NULL <> 'citizen' is NULL, i.e. not true).
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
  if current_role is distinct from 'citizen' or existing_institution is not null then raise exception 'Institution account cannot be created from this account'; end if;
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
revoke all on function public.create_institution_for_current_user(text,text,text,text) from public;
grant execute on function public.create_institution_for_current_user(text,text,text,text) to authenticated;

-- 5) promote_current_user_to_operator — require the citizen role explicitly.
--    ACL note: 0006 revoked this from `authenticated` (it is a bootstrap path reached
--    through the Edge Function with the service role). create-or-replace preserves the
--    existing ACL, so do NOT re-grant to authenticated here.
create or replace function public.promote_current_user_to_operator()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.current_reach_role() is distinct from 'citizen' or public.current_institution_id() is not null then raise exception 'Account is not eligible for operator provisioning'; end if;
  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles set role='operator' where id=auth.uid();
  insert into public.audit_logs(actor_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),'operator.provisioned','profile',auth.uid(),jsonb_build_object('source','server_provisioning_key'));
  select jsonb_build_object('id',id,'role',role,'institution_id',institution_id,'full_name',full_name) into result from public.profiles where id=auth.uid();
  return result;
end $$;

-- 6) register_my_relay_device — a NULL stored owner must never match a caller.
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
    if d.user_id is distinct from auth.uid() then
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
