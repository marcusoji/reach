/** REACH Safety Fusion v2
 * Deterministic, auditable emergency evidence fusion. AI is advisory only.
 * It deliberately abstains when evidence is weak, contradictory, stale, duplicated or model-disagreed.
 */
export type EvidenceKind='user_report'|'image'|'audio'|'motion'|'location'|'corroboration'|'relay'|'sensor'|'text';
export type Evidence={id?:string;kind:EvidenceKind;category?:string;confidence?:number;quality?:number;timestamp?:string;source?:string;corroborates?:boolean;contradiction?:boolean;metadata?:Record<string,unknown>};
export type Category='medical'|'fire'|'security'|'accident'|'other';
const CATEGORIES:Category[]=['medical','fire','security','accident','other'];
const WEIGHT:Record<EvidenceKind,number>={user_report:1,image:.9,audio:.65,motion:.45,location:.25,corroboration:.8,relay:.35,sensor:.5,text:.55};
const PRIOR=0.2;
const clamp=(n:number,a=0,b=1)=>Math.max(a,Math.min(b,n));
const conf=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?clamp(n<=1?n:n/100):0};
const ageFactor=(ts?:string)=>{if(!ts)return .8;const age=Math.max(0,(Date.now()-Date.parse(ts))/1000);return Number.isFinite(age)?Math.exp(-age/900):.5};
const sigmoid=(x:number)=>1/(1+Math.exp(-x));
function cleanEvidence(evidence:Evidence[]):Evidence[]{
  const seen=new Set<string>();
  return (evidence||[]).slice(0,80).filter(e=>{
    const key=e.id||`${e.kind}|${e.source||''}|${e.timestamp||''}|${e.category||''}`; if(seen.has(key))return false; seen.add(key); return true;
  });
}
export function assessEvidence(input:{reportedCategory?:string;userConfirmed?:boolean;evidence:Evidence[];locationAccuracyM?:number;corroboratingReports?:number;modelAssist?:{category:Category;confidence:number}|null}){
  const evidence=cleanEvidence(input.evidence); const scores:Record<Category,number>=Object.fromEntries(CATEGORIES.map(c=>[c,PRIOR])) as Record<Category,number>;
  let support=0, contradiction=0, independentSources=new Set<string>(); const reasons:string[]=[];
  for(const e of evidence){
    const q=clamp(Number(e.quality??1)); const c=conf(e.confidence??0); const w=(WEIGHT[e.kind]??.3)*q*ageFactor(e.timestamp); const contribution=w*c;
    support+=contribution; if(e.contradiction)contradiction+=w; if(e.source)independentSources.add(e.source);
    if(e.category&&CATEGORIES.includes(e.category as Category)) scores[e.category as Category]+=contribution*(e.corroborates===false?.45:1);
  }
  if(input.reportedCategory&&CATEGORIES.includes(input.reportedCategory as Category)) scores[input.reportedCategory as Category]+=input.userConfirmed===true?.45:.22;
  const ranked=(Object.entries(scores) as [Category,number][]).sort((a,b)=>b[1]-a[1]);
  let [category,top]=ranked[0]; const second=ranked[1][1]; const margin=top/(top+second+1e-6);
  const corroboration=Math.min(.2,Math.max(0,Number(input.corroboratingReports||0))*.04);
  const sourceDiversity=Math.min(.15,Math.max(0,independentSources.size-1)*.04);
  const evidenceStrength=clamp(support/2.4); const contradictionPenalty=Math.min(.3,contradiction*.09); const human=input.userConfirmed===true?.14:0;
  let raw=.38*margin+.34*evidenceStrength+.10*corroboration+.08*sourceDiversity+human-contradictionPenalty;
  let modelAgreement: 'agree'|'disagree'|'none'='none';
  if(input.modelAssist){
    modelAgreement=input.modelAssist.category===category?'agree':'disagree';
    if(modelAgreement==='agree') raw += .06*conf(input.modelAssist.confidence); else raw -= .10;
    if(modelAgreement==='disagree' && input.modelAssist.confidence>=.8) reasons.push('Independent model disagrees with the deterministic evidence ranking; assessment is downgraded.');
  }
  const confidence=Math.round(clamp(sigmoid((raw-.45)*7))*10000)/100;
  const abstain=confidence<60 || margin<.55 || evidenceStrength<.16 || contradictionPenalty>.18 || (modelAgreement==='disagree'&&confidence<78);
  if(input.userConfirmed===true)reasons.push('Citizen confirmation is present.');
  if(input.corroboratingReports)reasons.push(`${input.corroboratingReports} corroborating report(s) found.`);
  if(input.locationAccuracyM!=null)reasons.push(`Location accuracy recorded at approximately ${Math.round(input.locationAccuracyM)}m.`);
  if(independentSources.size>1)reasons.push(`${independentSources.size} independent evidence source(s) contributed.`);
  if(contradiction>0)reasons.push('Conflicting evidence reduced confidence.');
  if(abstain)reasons.push('Evidence is insufficient for autonomous action; human verification is required.'); else reasons.push('Evidence is sufficient for responder prioritization; human verification remains required.');
  const urgency=category==='medical'||category==='fire'||category==='security'?'high':'medium';
  return {
    model_name:'REACH-Safety-Fusion-v2',category,confidence,fp_code:`FP2-${category.toUpperCase()}-${Math.round(confidence)}-${Math.round(margin*100)}`,
    decision:abstain?'assist':'recommend',abstain,evidence_strength:Math.round(evidenceStrength*100)/100,margin:Math.round(margin*1000)/1000,
    contradiction_penalty:Math.round(contradictionPenalty*100)/100,source_diversity:independentSources.size,model_agreement:modelAgreement,urgency,reasons,explanation:reasons.join(' ')
  };
}
