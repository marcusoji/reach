import type { Evidence, Category } from './ai_engine.ts';
declare const Deno:{env:{get(name:string):string|undefined}};

export type ModelAssessment={category:Category;confidence:number;rationale:string;evidence_labels:string[];model:string;latency_ms:number};
const CATEGORIES:Category[]=['medical','fire','security','accident','other'];
const clamp=(n:number,a=0,b=100)=>Math.max(a,Math.min(b,n));

/** The provider is a second opinion, never an authority. This prompt deliberately does NOT claim an
 * agent identity: a provider that does not recognise the role can refuse it and answer in prose with
 * HTTP 200 (observed with Helix/Launchverse), which is a silent failure. State the output contract and
 * the safety limits only. */
export const MODEL_SYSTEM_PROMPT='Return a single JSON object and nothing else. No prose, no markdown, no code fences. Schema: {"category": one of "medical"|"fire"|"security"|"accident"|"other", "confidence": integer 0-100, "rationale": string (<=800 chars), "evidence_labels": array of strings (<=8)}. Classify the supplied emergency evidence conservatively. Do not invent observations, sensor values, locations, people, injuries, fires, weapons, or certainty. Lower confidence when evidence is weak or contradictory. Never recommend an autonomous emergency action.';

/** Why the last provider call failed. Prose served as 200 (a refusal, or a billing notice) is a
 * distinct case from a network/HTTP error and must be diagnosable without a packet capture. */
let lastFailure='';
export function aiLastFailure(){return lastFailure;}

const envNum=(k:string,d:number)=>{const n=Number(Deno.env.get(k));return Number.isFinite(n)&&n>0?n:d;};

/** Consecutive provider failures. Once the provider fails BREAKER_THRESHOLD times in a row,
 * stop calling it for BREAKER_COOLDOWN_MS so a dead provider cannot add its timeout to every
 * assessment. The platform keeps working: the deterministic engine just runs without a second
 * opinion. A success, or the cooldown elapsing, closes the breaker. */
let failures=0, openedAt=0;
export function aiCircuitSnapshot(){return {failures,open:openedAt>0&&Date.now()-openedAt<envNum('REACH_AI_BREAKER_COOLDOWN_MS',60_000),opened_at:openedAt};}
export function resetAiCircuit(){failures=0;openedAt=0;lastFailure='';}

/** Provider adapter. The external model is a second opinion and never authorizes response. */
export async function modelAssist(input:{category?:string;description?:string;evidence:Evidence[]}):Promise<ModelAssessment|null>{
  const endpoint=Deno.env.get('REACH_AI_ENDPOINT'); const key=Deno.env.get('REACH_AI_API_KEY'); const model=Deno.env.get('REACH_AI_MODEL');
  if(!endpoint||!key||!model)return null;
  // Read config per call so it can be tuned without a redeploy of module state.
  const threshold=envNum('REACH_AI_BREAKER_THRESHOLD',5), cooldownMs=envNum('REACH_AI_BREAKER_COOLDOWN_MS',60_000), timeoutMs=envNum('REACH_AI_TIMEOUT_MS',6500);
  if(openedAt>0&&Date.now()-openedAt<cooldownMs)return null;
  const controller=new AbortController(); const started=Date.now(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const fail=()=>{failures+=1;if(failures>=threshold)openedAt=Date.now();return null;};
  const succeed=(r:ModelAssessment)=>{failures=0;openedAt=0;lastFailure='';return r;};
  const evidence=input.evidence.slice(0,30).map(e=>({kind:e.kind,category:e.category,confidence:e.confidence,quality:e.quality,timestamp:e.timestamp,source:e.source,corroborates:e.corroborates,contradiction:e.contradiction,metadata:e.metadata}));
  const body={model,temperature:0,max_tokens:700,response_format:{type:'json_object'},messages:[
    {role:'system',content:MODEL_SYSTEM_PROMPT},
    {role:'user',content:JSON.stringify({reported_category:input.category,description:(input.description||'').slice(0,2000),evidence})}
  ]};
  try{
    let response:Response|null=null;
    for(let attempt=0;attempt<2;attempt++){
      try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'X-REACH-AI-Version':'2'},body:JSON.stringify(body),signal:controller.signal});if(response.ok)break;}catch{if(attempt===1)return fail();}
    }
    if(!response?.ok)return fail();
    const rawBody=await response.json(); const raw=rawBody?.choices?.[0]?.message?.content??rawBody?.output??rawBody;
    // A provider that serves prose as HTTP 200 (an identity refusal, or a billing notice such as
    // "credit balance exhausted") arrives here as a non-JSON string. Record the leading text so the
    // cause is diagnosable, and cap it so a long completion cannot bloat memory.
    let obj:any;
    if(typeof raw==='string'){
      try{obj=JSON.parse(raw)}catch{lastFailure=`non-JSON provider response: ${raw.slice(0,160)}`;return fail();}
    } else obj=raw;
    if(!CATEGORIES.includes(obj?.category))return fail(); const confidence=clamp(Number(obj?.confidence)); if(!Number.isFinite(confidence))return fail();
    const rationale=String(obj?.rationale||'').trim().slice(0,800); const labels=Array.isArray(obj?.evidence_labels)?obj.evidence_labels.slice(0,8).map(String):[];
    return succeed({category:obj.category,confidence,rationale,evidence_labels:labels,model,latency_ms:Date.now()-started});
  }catch(error){
    lastFailure=String(error instanceof Error?error.message:error).slice(0,200);
    return fail();
  }finally{clearTimeout(timer)}
}
