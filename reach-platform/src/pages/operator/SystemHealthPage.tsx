import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { Badge, BadgeVariant } from '../../components/common/Badge';
import { getSystemHealth, isBackendConfigured } from '../../lib/reachApi';

export const SystemHealthPage: React.FC = () => {
  const [items, setItems] = useState<any[]>([]);
  const [overall, setOverall] = useState<string | null>(null);
  useEffect(() => {
    if (!isBackendConfigured) return;
    void getSystemHealth()
      .then((r) => { setItems(r.data || []); setOverall((r as any).overall ?? null); })
      .catch(() => undefined);
  }, []);
  const variantFor = (status: string): BadgeVariant =>
    status === 'Healthy' || status === 'Configured' ? 'healthy'
      : status === 'Degraded' ? 'grace'
      : status === 'Unhealthy' || status === 'Circuit open' ? 'unhealthy'
      : 'inactive';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader eyebrow="SAAS OPERATOR" title="System health" subtitle="Current REACH API and core pipeline health checks." />
      <div className="reach-card" style={{ padding: '1.5rem', gap: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>Subsystem Status</h2>
          {overall && <Badge variant={overall === 'healthy' ? 'healthy' : 'grace'}>{overall === 'healthy' ? 'Healthy' : 'Degraded'}</Badge>}
        </div>
        <div className="key-value-list" style={{ padding: 0 }}>
          {items.map((item: any, i) => (
            <KeyValueRow key={`${item.service}-${i}`} label={<span style={{ fontWeight: 700 }}>{item.service}</span>} value={<Badge variant={variantFor(String(item.status))}>{item.status}</Badge>} />
          ))}
          {!items.length && <p>Health data is unavailable until the backend is configured.</p>}
        </div>
      </div>
    </div>
  );
};
