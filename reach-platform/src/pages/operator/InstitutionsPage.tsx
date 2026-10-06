import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { FilterPills } from '../../components/common/FilterPills';
import { Badge } from '../../components/common/Badge';
import { isBackendConfigured, listInstitutions } from '../../lib/reachApi';
import { useApp } from '../../context/AppContext';

/** Map a subscription status to the operator-facing plan status. A missing subscription is
 *  "Inactive", not "Active" — the old filter compared against a field the list endpoint never
 *  returns, so every row fell through to 'Active' and the Active/Grace/Inactive tabs did nothing. */
const planStatus = (inst: any): 'Active' | 'Grace' | 'Inactive' => {
  // PostgREST returns a to-many embed as an array; tolerate a single object too.
  const sub = Array.isArray(inst?.subscriptions) ? inst.subscriptions[0] : (inst?.subscriptions || inst?.subscription);
  const s = String(sub?.status ?? '').toLowerCase();
  if (s === 'active') return 'Active';
  if (s === 'trial' || s === 'grace' || s === 'past_due') return 'Grace';
  return 'Inactive';
};

export const InstitutionsPage: React.FC = () => {
  const { institutions: fallback } = useApp(); const [items,setItems]=useState<any[]>(fallback); const [filter,setFilter]=useState('all'); const [loaded,setLoaded]=useState(!isBackendConfigured);
  useEffect(()=>{if(isBackendConfigured) void listInstitutions().then(r=>setItems(r.data||[])).catch(()=>undefined).finally(()=>setLoaded(true));},[]);
  const filterOptions=[{id:'all',label:'All'},{id:'Active',label:'Active'},{id:'Grace',label:'Grace'},{id:'Inactive',label:'Inactive'}];
  const shown = items.filter((i:any)=>filter==='all'||planStatus(i)===filter);
  return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}><SectionHeader eyebrow="SAAS OPERATOR" title="Institutions" subtitle="Manage the organizations operating on REACH."/><FilterPills options={filterOptions} activeId={filter} onChange={setFilter}/><div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>{shown.map((inst:any)=><div key={inst.id} className="reach-card" style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'1rem'}}><div><p style={{color:'var(--reach-text-secondary)',fontSize:'.9rem',fontWeight:600}}>{inst.category}</p><h2 style={{fontSize:'1.6rem',fontWeight:900}}>{inst.name}</h2><p style={{fontSize:'.9rem',color:'var(--reach-text-secondary)'}}>{inst.city || 'Location not supplied'}</p></div><Badge variant={planStatus(inst)==='Active'?'active':planStatus(inst)==='Grace'?'grace':'inactive'}>{planStatus(inst)}</Badge></div>)}{!shown.length&&<div className="reach-card"><p>{!loaded ? 'Loading institutions…' : items.length ? `No institutions match "${filter}".` : 'No institutions available.'}</p></div>}</div></div>;
};
