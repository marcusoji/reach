import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { getSystemHealth, isBackendConfigured, listAuditLogs } from '../../lib/reachApi';

export const AuditLogPage: React.FC = () => { const [logs,setLogs]=useState<any[]>([]); useEffect(()=>{if(isBackendConfigured)void listAuditLogs().then(r=>setLogs(r.data||[])).catch(()=>undefined);},[]); return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}><SectionHeader eyebrow="SAAS OPERATOR" title="Audit log" subtitle="Security trail for authenticated platform actions and workflow transitions."/><div className="reach-card" style={{padding:'1.5rem',gap:'1.25rem'}}><div className="key-value-list" style={{padding:0}}>{logs.length?logs.map(log=><KeyValueRow key={log.id} label={<span style={{fontWeight:800,color:'var(--reach-brand)'}}>{new Date(log.created_at).toLocaleString()}</span>} value={<span style={{fontWeight:600}}>{log.action}{log.resource_id?` · ${log.resource_id}`:''}</span>}/>):<p>No audit events available.</p>}</div></div></div>; };
