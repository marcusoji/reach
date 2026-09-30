import type { Evidence, Category } from './ai_engine.ts';
declare const Deno:{env:{get(name:string):string|undefined}};

export type ModelAssessment={category:Category;confidence:number;rationale:string;evidence_labels:string[];model:string;latency_ms:number};
const CATEGORIES:Category[]=['medical','fire','security','accident','other'];
const clamp=(n:number,a=0,b=100)=>Math.max(a,Math.min(b,n));

/** Provider adapter. The external model is a second opinion and never authorizes response. */
export async function modelAssist(input:{category?:string;description?:string;evidence:Evidence[]}):Promise<ModelAssessment|null>{
  const endpoint=Deno.env.get('REACH_AI_ENDPOINT'); const key=Deno.env.get('REACH_AI_API_KEY'); const model=Deno.env.get('REACH_AI_MODEL');
  if(!endpoint||!key||!model)return null;
  const controller=new AbortController(); const started=Date.now(); const timer=setTimeout(()=>controller.abort(),6500);
  const evidence=input.evidence.slice(0,30).map(e=>({kind:e.kind,category:e.category,confidence:e.confidence,quality:e.quality,timestamp:e.timestamp,source:e.source,corroborates:e.corroborates,contradiction:e.contradiction,metadata:e.metadata}));
  const body={model,temperature:0,max_tokens:700,response_format:{type:'json_object'},messages:[
    {role:'system',content:'You are REACH Safety Assist. Classify emergency evidence conservatively. You must not invent observations, sensor values, locations, people, injuries, fires, weapons, or certainty. Return JSON only: category (medical|fire|security|accident|other), confidence (0-100), rationale (<=800 chars), evidence_labels (array <=8). If evidence is weak or contradictory, lower confidence. Never recommend an autonomous emergency action.'},
    {role:'user',content:JSON.stringify({reported_category:input.category,description:(input.description||'').slice(0,2000),evidence})}
  ]};
  try{
    let response:Response|null=null;
    for(let attempt=0;attempt<2;attempt++){
      try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'X-REACH-AI-Version':'2'},body:JSON.stringify(body),signal:controller.signal});if(response.ok)break;}catch{if(attempt===1)throw new Error('AI provider unavailable');}
    }
    if(!response?.ok)return null;
    const rawBody=await response.json(); const raw=rawBody?.choices?.[0]?.message?.content??rawBody?.output??rawBody; const obj=typeof raw==='string'?JSON.parse(raw):raw;
    if(!CATEGORIES.includes(obj?.category))return null; const confidence=clamp(Number(obj?.confidence)); if(!Number.isFinite(confidence))return null;
    const rationale=String(obj?.rationale||'').trim().slice(0,800); const labels=Array.isArray(obj?.evidence_labels)?obj.evidence_labels.slice(0,8).map(String):[];
    return {category:obj.category,confidence,rationale,evidence_labels:labels,model,latency_ms:Date.now()-started};
  }catch{return null}finally{clearTimeout(timer)}
}
