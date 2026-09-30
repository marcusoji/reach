import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { FilterPills } from '../../components/common/FilterPills';
import { Badge } from '../../components/common/Badge';
import { getInstitutionSummary, isBackendConfigured, listInstitutions } from '../../lib/reachApi';
import { useApp } from '../../context/AppContext';

export const InstitutionsPage: React.FC = () => {
  const { institutions: fallback } = useApp(); const [items,setItems]=useState<any[]>(fallback); const [filter,setFilter]=useState('all');
  useEffect(()=>{if(isBackendConfigured) void listInstitutions().then(r=>setItems(r.data||[])).catch(()=>undefined);},[]);
  const filterOptions=[{id:'all',label:'All'},{id:'Active',label:'Active'},{id:'Grace',label:'Grace'},{id:'Inactive',label:'Inactive'}];
  return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}><SectionHeader eyebrow="SAAS OPERATOR" title="Institutions" subtitle="Manage the organizations operating on REACH."/><FilterPills options={filterOptions} activeId={filter} onChange={setFilter}/><div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>{items.filter((i:any)=>filter==='all'||(i.status||'Active')===filter).map((inst:any)=><div key={inst.id} className="reach-card" style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'1rem'}}><div><p style={{color:'var(--reach-text-secondary)',fontSize:'.9rem',fontWeight:600}}>{inst.category}</p><h2 style={{fontSize:'1.6rem',fontWeight:900}}>{inst.name}</h2><p style={{fontSize:'.9rem',color:'var(--reach-text-secondary)'}}>{inst.city || 'Location not supplied'}</p></div><Badge variant="active">{inst.status || 'Active'}</Badge></div>)}{!items.length&&<div className="reach-card"><p>No institutions available.</p></div>}</div></div>;
};
