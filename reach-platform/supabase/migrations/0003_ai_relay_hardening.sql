-- REACH AI + relay hardening
-- AI never authorizes an emergency response. It produces an auditable assessment only.

create or replace function public.store_ai_assessment_for_incident(
  p_incident_id uuid,
  p_model_name text,
  p_category public.incident_category,
  p_confidence numeric,
  p_fp_code text,
  p_evidence_ids uuid[] default '{}',
  p_explanation text default '',
  p_decision text default 'assist',
  p_metadata jsonb default '{}'::jsonb
) returns public.ai_assessments
language plpgsql security definer set search_path=public
as $$
declare i public.incidents; a public.ai_assessments;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into i from public.incidents where id=p_incident_id;
  if not found then raise exception 'Incident not found'; end if;
  if not (i.reporter_id=auth.uid() or i.institution_id=public.current_institution_id() or public.has_reach_role(array['operator','super-admin']::public.reach_role[])) then raise exception 'Not permitted'; end if;
  if p_confidence < 0 or p_confidence > 100 then raise exception 'Invalid confidence'; end if;
  if p_decision not in ('assist','recommend') then raise exception 'AI decision must remain assist/recommend'; end if;
  insert into public.ai_assessments(incident_id,model_name,category,confidence,fp_code,evidence_ids,explanation,decision)
  values(p_incident_id,left(coalesce(p_model_name,'REACH-Safety-Fusion-v1'),120),p_category,p_confidence,left(p_fp_code,120),coalesce(p_evidence_ids,'{}'),left(coalesce(p_explanation,''),4000),p_decision)
  returning * into a;
  update public.incidents set ai_confidence=p_confidence, ai_fp_code=left(p_fp_code,120), updated_at=now() where id=p_incident_id;
  perform public.append_audit_log('ai.assessment','incident',p_incident_id,jsonb_build_object('assessment_id',a.id,'model',p_model_name,'decision',p_decision,'metadata',p_metadata));
  return a;
end; $$;

revoke all on function public.store_ai_assessment_for_incident(uuid,text,public.incident_category,numeric,text,uuid[],text,text,jsonb) from public;
grant execute on function public.store_ai_assessment_for_incident(uuid,text,public.incident_category,numeric,text,uuid[],text,text,jsonb) to authenticated;

-- Prevent clients from inserting arbitrary AI rows directly.
drop policy if exists ai_insert on public.ai_assessments;
create policy ai_insert_none on public.ai_assessments for insert with check (false);

-- Relay packet ingestion gets a deterministic packet fingerprint check when the packet includes canonical fields.
create or replace function public.ingest_relay_packet(p_packet jsonb)
returns public.relay_packets
language plpgsql security definer set search_path=public
as $$
declare r public.relay_packets; incident_inst uuid; hops int; maxh int; expires timestamptz; pkey text; phash text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  pkey := trim(coalesce(p_packet->>'packet_key',''));
  phash := trim(coalesce(p_packet->>'packet_hash',''));
  hops := coalesce((p_packet->>'hop_count')::int,0); maxh := coalesce((p_packet->>'max_hops')::int,6);
  expires := coalesce((p_packet->>'ttl_expires_at')::timestamptz, now()+interval '30 minutes');
  if length(pkey)<8 or length(phash)<16 then raise exception 'Packet identity required'; end if;
  if hops<0 or maxh<1 or maxh>6 or hops>=maxh or expires<=now() then raise exception 'Expired or invalid relay packet'; end if;
  if not (p_packet ? 'incident_id') or nullif(trim(p_packet->>'incident_id'),'') is null then raise exception 'Incident ID required'; end if;
  if p_packet ? 'incident_id' then
    select institution_id into incident_inst from public.incidents where id=(p_packet->>'incident_id')::uuid;
    if not found then raise exception 'Incident not found'; end if;
    if incident_inst is not null and public.current_institution_id() is distinct from incident_inst and not public.has_reach_role(array['operator','super-admin']::public.reach_role[]) then raise exception 'Relay packet belongs to another institution'; end if;
  end if;
  insert into public.relay_packets(packet_key,incident_id,source_device_id,relay_device_id,gateway_id,hop_count,max_hops,ttl_expires_at,status,packet_hash,minimal_payload,received_at)
  values(pkey,nullif(p_packet->>'incident_id','')::uuid,left(p_packet->>'source_device_id',160),left(p_packet->>'relay_device_id',160),left(p_packet->>'gateway_id',160),hops,maxh,expires,'received',phash,coalesce(p_packet->'minimal_payload','{}'::jsonb),now())
  on conflict(packet_key) do update set relay_device_id=excluded.relay_device_id, gateway_id=excluded.gateway_id, status=case when public.relay_packets.status='delivered' then 'delivered' else 'received' end, received_at=now()
  returning * into r;
  return r;
end; $$;

-- Audit append is internal-only; clients must not be able to manufacture audit history.
revoke all on function public.append_audit_log(text,text,uuid,jsonb) from public;
revoke all on function public.append_audit_log(text,text,uuid,jsonb) from anon;
revoke all on function public.append_audit_log(text,text,uuid,jsonb) from authenticated;

-- The ingestion function rejects missing incident IDs; the nullable column is retained for compatibility with existing rows.
