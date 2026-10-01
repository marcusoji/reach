import type { Evidence, Category } from './ai_engine.ts';
declare const Deno:{env:{get(name:string):string|undefined}};

export type ModelAssessment={category:Category;confidence:number;rationale:string;evidence_labels:string[];model:string;latency_ms:number};
const CATEGORIES:Category[]=['medical','fire','security','accident','other'];
const clamp=(n:number,a=0,b=100)=>Math.max(a,Math.min(b,n));

const envNum=(k:string,d:number)=>{const n=Number(Deno.env.get(k));return Number.isFinite(n)&&n>0?n:d;};

/** Consecutive provider failures. Once the provider fails BREAKER_THRESHOLD times in a row,
 * stop calling it for BREAKER_COOLDOWN_MS so a dead provider cannot add its timeout to every
 * assessment. The platform keeps working: the deterministic engine just runs without a second
 * opinion. A success, or the cooldown elapsing, closes the breaker. */
let failures=0, openedAt=0;
export function aiCircuitSnapshot(){return {failures,open:openedAt>0&&Date.now()-openedAt<envNum('REACH_AI_BREAKER_COOLDOWN_MS',60_000),opened_at:openedAt};}
export function resetAiCircuit(){failures=0;openedAt=0;}

/** Provider adapter. The external model is a second opinion and never authorizes response. */
export async function modelAssist(input:{category?:string;description?:string;evidence:Evidence[]}):Promise<ModelAssessment|null>{
  const endpoint=Deno.env.get('REACH_AI_ENDPOINT'); const key=Deno.env.get('REACH_AI_API_KEY'); const model=Deno.env.get('REACH_AI_MODEL');
  if(!endpoint||!key||!model)return null;
  // Read config per call so it can be tuned without a redeploy of module state.
  const threshold=envNum('REACH_AI_BREAKER_THRESHOLD',5), cooldownMs=envNum('REACH_AI_BREAKER_COOLDOWN_MS',60_000), timeoutMs=envNum('REACH_AI_TIMEOUT_MS',6500);
  if(openedAt>0&&Date.now()-openedAt<cooldownMs)return null;
  const controller=new AbortController(); const started=Date.now(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const fail=()=>{failures+=1;if(failures>=threshold)openedAt=Date.now();return null;};
  const succeed=(r:ModelAssessment)=>{failures=0;openedAt=0;return r;};
  const evidence=input.evidence.slice(0,30).map(e=>({kind:e.kind,category:e.category,confidence:e.confidence,quality:e.quality,timestamp:e.timestamp,source:e.source,corroborates:e.corroborates,contradiction:e.contradiction,metadata:e.metadata}));
  const body={model,temperature:0,max_tokens:700,response_format:{type:'json_object'},messages:[
    {role:'system',content:'You are REACH Safety Assist. Classify emergency evidence conservatively. You must not invent observations, sensor values, locations, people, injuries, fires, weapons, or certainty. Return JSON only: category (medical|fire|security|accident|other), confidence (0-100), rationale (<=800 chars), evidence_labels (array <=8). If evidence is weak or contradictory, lower confidence. Never recommend an autonomous emergency action.'},
    {role:'user',content:JSON.stringify({reported_category:input.category,description:(input.description||'').slice(0,2000),evidence})}
  ]};
  try{
    let response:Response|null=null;
    for(let attempt=0;attempt<2;attempt++){
      try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'X-REACH-AI-Version':'2'},body:JSON.stringify(body),signal:controller.signal});if(response.ok)break;}catch{if(attempt===1)return fail();}
    }
    if(!response?.ok)return fail();
    const rawBody=await response.json(); const raw=rawBody?.choices?.[0]?.message?.content??rawBody?.output??rawBody; const obj=typeof raw==='string'?JSON.parse(raw):raw;
    if(!CATEGORIES.includes(obj?.category))return fail(); const confidence=clamp(Number(obj?.confidence)); if(!Number.isFinite(confidence))return fail();
    const rationale=String(obj?.rationale||'').trim().slice(0,800); const labels=Array.isArray(obj?.evidence_labels)?obj.evidence_labels.slice(0,8).map(String):[];
    return succeed({category:obj.category,confidence,rationale,evidence_labels:labels,model,latency_ms:Date.now()-started});
  }catch{return fail()}finally{clearTimeout(timer)}
}
