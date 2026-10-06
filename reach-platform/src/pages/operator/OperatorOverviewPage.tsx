import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { StatCard } from '../../components/common/StatCard';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { LoadingPanel } from '../../components/common/LoadingPanel';
import { getOperatorSummary, isBackendConfigured } from '../../lib/reachApi';
import { useApp } from '../../context/AppContext';

export const OperatorOverviewPage: React.FC = () => {
  const { incidents, institutions, dataLoading } = useApp();
  const [summary, setSummary] = useState<any>(null);
  useEffect(() => { if (isBackendConfigured) void getOperatorSummary().then(r=>setSummary(r.data)).catch(()=>undefined); }, []);
  const openCount = summary?.activeCount ?? incidents.filter(i => !['Resolved', 'Closed'].includes(i.status)).length;
  const institutionCount = summary?.institutionCount ?? institutions.length;
  const recent = summary?.recent ?? incidents.slice(0,8).map(i=>({id:i.id,code:i.code,status:i.status,category:i.category,priority:'—',reported_at:i.timestamp}));
  if (!summary && dataLoading) return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}><SectionHeader eyebrow="SAAS OPERATOR" title="Platform Overview" subtitle="Watch institutions and health. AI assists routing; human responders retain operational control." /><LoadingPanel label="Loading platform overview…" /></div>;
  return <div style={{display:'flex',flexDirection:'column',gap:'2rem'}}>
    <SectionHeader eyebrow="SAAS OPERATOR" title="Platform Overview" subtitle="Watch institutions and health. AI assists routing; human responders retain operational control." />
    <div className="stat-card-grid"><StatCard label="Institutions" value={institutionCount} /><StatCard label="Open incidents" value={openCount} /><StatCard label="Relay delivered" value={summary?.relayDelivered ?? '—'} /></div>
    <div className="reach-card" style={{padding:'1.5rem',gap:'1.25rem'}}><h2 style={{fontSize:'1.3rem',fontWeight:800}}>Recent platform activity</h2><div className="key-value-list" style={{padding:0}}>{recent.length ? recent.map((feed:any)=><KeyValueRow key={feed.id} label={<span style={{fontWeight:700,color:'var(--reach-brand)'}}>{new Date(feed.reported_at).toLocaleTimeString()}</span>} value={<span style={{fontWeight:600}}>{feed.code} · {feed.category} · {String(feed.status).replace('_',' ')}</span>} />) : <p>No platform incidents yet.</p>}</div></div>
  </div>;
};
