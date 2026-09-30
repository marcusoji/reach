import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { Badge } from '../../components/common/Badge';
import { getSystemHealth, isBackendConfigured } from '../../lib/reachApi';

export const SystemHealthPage: React.FC = () => { const [items,setItems]=useState<any[]>([]); useEffect(()=>{if(isBackendConfigured)void getSystemHealth().then(r=>setItems(r.data||[])).catch(()=>undefined);},[]); return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}><SectionHeader eyebrow="SAAS OPERATOR" title="System health" subtitle="Current REACH API and core pipeline health checks."/><div className="reach-card" style={{padding:'1.5rem',gap:'1.25rem'}}><h2 style={{fontSize:'1.3rem',fontWeight:800}}>Subsystem Status</h2><div className="key-value-list" style={{padding:0}}>{items.map((item:any,i)=><KeyValueRow key={`${item.service}-${i}`} label={<span style={{fontWeight:700}}>{item.service}</span>} value={<Badge variant={item.status==='Healthy'?'healthy':item.status==='Degraded'?'grace':'unhealthy'}>{item.status}</Badge>}/>)}{!items.length&&<p>Health data is unavailable until the backend is configured.</p>}</div></div></div>; };
