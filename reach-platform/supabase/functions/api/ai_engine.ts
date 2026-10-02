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
const finite=(n:unknown,d=0)=>{const x=Number(n);return Number.isFinite(x)?x:d};
const conf=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?clamp(n<=1?n:n/100):0};
const ageFactor=(ts?:string)=>{if(!ts)return .8;const age=Math.max(0,(Date.now()-Date.parse(ts))/1000);return Number.isFinite(age)?Math.exp(-age/900):.5};
const sigmoid=(x:number)=>1/(1+Math.exp(-x));
function cleanEvidence(evidence:Evidence[]):Evidence[]{
  const seen=new Set<string>();
  // `evidence` arrives straight from a JSON body, so it may be absent, non-array, or contain
  // null/garbage entries. Drop those instead of throwing (a malformed item used to crash the
  // handler) or letting NaN leak into the fusion math.
  return (Array.isArray(evidence)?evidence:[]).slice(0,80).filter(e=>{
    if(!e||typeof e!=='object')return false;
    const key=e.id||`${e.kind}|${e.source||''}|${e.timestamp||''}|${e.category||''}`; if(seen.has(key))return false; seen.add(key); return true;
  });
}
export function assessEvidence(input:{reportedCategory?:string;userConfirmed?:boolean;evidence:Evidence[];locationAccuracyM?:number;corroboratingReports?:number;modelAssist?:{category:Category;confidence:number}|null}){
  const evidence=cleanEvidence(input.evidence); const scores:Record<Category,number>=Object.fromEntries(CATEGORIES.map(c=>[c,PRIOR])) as Record<Category,number>;
  let support=0, contradiction=0, independentSources=new Set<string>(); const reasons:string[]=[];
  for(const e of evidence){
    // quality may be a non-numeric string from a JSON body: Number() would yield NaN and poison
    // every downstream score (confidence, margin, strength), which silenced the abstention
    // blockers and produced a bogus `recommend` with a NaN fingerprint. An absent quality keeps
    // the full-quality default; a present-but-invalid one contributes nothing.
    const q=e.quality==null?1:clamp(finite(e.quality,0)); const c=conf(e.confidence??0); const w=(WEIGHT[e.kind]??.3)*q*ageFactor(e.timestamp);
    // Contradicting evidence must only reduce confidence: it feeds the penalty and nothing
    // else. Counting it as support (or into its own category score) made confidence rise
    // with the number of contradicting sensors, so an item flagged contradiction:true could
    // push the decision to 'recommend'.
    if(e.contradiction){contradiction+=w;continue;}
    const contribution=w*c;
    // A source that marks its own item as not corroborating is counter-evidence, not weak
    // support. It used to be merely discounted (x0.45) while still raising support and its
    // category score, so "corroborates:false" items could still increase confidence.
    if(e.corroborates===false){contradiction+=contribution*.5;continue;}
    support+=contribution; if(e.source)independentSources.add(e.source);
    if(e.category&&CATEGORIES.includes(e.category as Category)) scores[e.category as Category]+=contribution;
  }
  if(input.reportedCategory&&CATEGORIES.includes(input.reportedCategory as Category)) scores[input.reportedCategory as Category]+=input.userConfirmed===true?.45:.22;
  const ranked=(Object.entries(scores) as [Category,number][]).sort((a,b)=>b[1]-a[1]);
  let [category,top]=ranked[0]; const second=ranked[1][1]; const margin=top/(top+second+1e-6);
  const corroboration=Math.min(.2,Math.max(0,finite(input.corroboratingReports,0))*.04);
  const sourceDiversity=Math.min(.15,Math.max(0,independentSources.size-1)*.04);
  const evidenceStrength=clamp(support/2.4); const contradictionPenalty=Math.min(.3,contradiction*.09); const human=input.userConfirmed===true?.14:0;
  let raw=.38*margin+.34*evidenceStrength+.10*corroboration+.08*sourceDiversity+human-contradictionPenalty;
  let modelAgreement: 'agree'|'disagree'|'none'='none';
  if(input.modelAssist){
    // A model confidence that is not a finite number is unusable: treat the second opinion as
    // absent rather than letting NaN flow into `raw` and null out the confidence/blockers.
    const modelConf=finite(input.modelAssist.confidence,NaN);
    if(Number.isFinite(modelConf)){
      modelAgreement=input.modelAssist.category===category?'agree':'disagree';
      if(modelAgreement==='agree') raw += .06*conf(modelConf); else raw -= .10;
      if(modelAgreement==='disagree' && modelConf>=.8) reasons.push('Independent model disagrees with the deterministic evidence ranking; assessment is downgraded.');
    }
  }
  const confidence=Math.round(clamp(sigmoid((raw-.45)*7))*10000)/100;
  // Machine-readable abstention trace. Substring-matching the human-readable reasons to learn
  // *why* the engine abstained is brittle; consumers get the exact trigger list here instead.
  const blockers:string[]=[];
  if(evidence.length===0)blockers.push('no_usable_evidence');
  if(confidence<60)blockers.push('confidence_below_threshold');
  if(margin<.55)blockers.push('category_margin_below_threshold');
  if(evidenceStrength<.16)blockers.push('evidence_strength_below_threshold');
  if(contradictionPenalty>.18)blockers.push('contradiction_penalty_above_threshold');
  if(modelAgreement==='disagree'&&confidence<78)blockers.push('model_disagreement');
  const abstain=blockers.length>0;
  const decision_basis={
    signals:{margin:Math.round(margin*1000)/1000,evidence_strength:Math.round(evidenceStrength*100)/100,contradiction_penalty:Math.round(contradictionPenalty*100)/100,source_diversity:independentSources.size,model_agreement:modelAgreement,human_confirmation:input.userConfirmed===true},
    blockers
  };
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
    contradiction_penalty:Math.round(contradictionPenalty*100)/100,source_diversity:independentSources.size,model_agreement:modelAgreement,urgency,reasons,decision_basis,explanation:reasons.join(' ')
  };
}
