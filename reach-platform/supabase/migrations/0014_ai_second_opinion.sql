-- REACH AI second-opinion auditability
-- The external model is a second opinion; the deterministic engine decides. Persist enough to
-- audit what the model contributed and whether it agreed with the engine, so the operator view
-- can show the second opinion instead of only the fused result.

-- Why the engine abstained, the model's own category/confidence, and the fusion signals.
-- Without this the operator view can only show the fused result, not what the model contributed.
alter table public.ai_assessments
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Read path for the operator view: newest first per incident.
create index if not exists ai_assessments_incident_created_idx
  on public.ai_assessments (incident_id, created_at desc);

-- Persist the assessment metadata that the API already computes and passes in p_metadata.
-- Previously it reached only append_audit_log, so model_agreement/model_used could not be
-- queried back out and the operator view had nothing to show.
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
  insert into public.ai_assessments(incident_id,model_name,category,confidence,fp_code,evidence_ids,explanation,decision,metadata)
  values(p_incident_id,left(coalesce(p_model_name,'REACH-Safety-Fusion-v2'),120),p_category,p_confidence,left(p_fp_code,120),coalesce(p_evidence_ids,'{}'),left(coalesce(p_explanation,''),4000),p_decision,coalesce(p_metadata,'{}'::jsonb))
  returning * into a;
  update public.incidents set ai_confidence=p_confidence, ai_fp_code=left(p_fp_code,120), updated_at=now() where id=p_incident_id;
  perform public.append_audit_log('ai.assessment','incident',p_incident_id,jsonb_build_object('assessment_id',a.id,'model',p_model_name,'decision',p_decision,'metadata',p_metadata));
  return a;
end; $$;

revoke all on function public.store_ai_assessment_for_incident(uuid,text,public.incident_category,numeric,text,uuid[],text,text,jsonb) from public;
grant execute on function public.store_ai_assessment_for_incident(uuid,text,public.incident_category,numeric,text,uuid[],text,text,jsonb) to authenticated;
