import React from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { StatCard } from '../../components/common/StatCard';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { LoadingPanel } from '../../components/common/LoadingPanel';
import { useApp } from '../../context/AppContext';

export const OverviewPage: React.FC = () => {
  const { institutions, incidents, backendStatus, dataLoading } = useApp();
  const currentInstitution = institutions[0];
  if (!currentInstitution) return dataLoading ? <LoadingPanel label="Loading institution…" /> : <div className="reach-card" style={{padding:'2rem'}}><h2>Institution data unavailable</h2><p style={{color:'var(--reach-text-secondary)',marginTop:8}}>Connect the REACH backend or finish institution setup to load live data.</p></div>; // Greenfield Estate
  const openCount = incidents.filter((i) => !['Resolved', 'Closed'].includes(i.status)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow={`Institution - ${currentInstitution.name}`}
        tag={currentInstitution.code}
        title="Overview"
        subtitle="One plan. AI assists your desk. Members never pay."
      />

      {/* Metric Cards Grid */}
      <div className="stat-card-grid">
        <StatCard label="Plan" value={currentInstitution.plan} compact />
        <StatCard label="Status" value={currentInstitution.status} compact />
        <StatCard label="Open" value={openCount} />
        <StatCard label="Residents" value={currentInstitution.residentsCount} />
        <StatCard label="Staffs" value={currentInstitution.staffCount} />
        <StatCard label="Security" value={currentInstitution.securityCount} />
        <StatCard label="Total Coverage" value={currentInstitution.coverageCount} />
      </div>

      {/* Desktop 2-Column Cards Grid */}
      <div className="desktop-two-col">
        {/* Subscription Summary Card */}
        <div className="reach-card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Subscription
          </h2>
          <div className="key-value-list" style={{ padding: 0 }}>
            <KeyValueRow
              label="Subscription"
              value={
                <span style={{ color: 'var(--status-success-text)', fontWeight: 700 }}>
                  {currentInstitution.status}
                </span>
              }
            />
            <KeyValueRow label="Plan" value={currentInstitution.plan} />
            <KeyValueRow label="Next Charge" value={currentInstitution.nextCharge} />
            <KeyValueRow label="Payment API" value={currentInstitution.paymentApi} />
          </div>
        </div>

        {/* Security Desk Operational Status Card */}
        <div className="reach-card" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Security Desk
          </h2>
          <div className="key-value-list" style={{ padding: 0 }}>
            <KeyValueRow
              label="Status"
              value={
                <span style={{ color: backendStatus === 'offline' ? 'var(--reach-brand)' : 'var(--status-success-text)', fontWeight: 700 }}>
                  {backendStatus === 'checking' ? 'Checking…' : backendStatus === 'online' ? 'Online' : 'Backend unavailable'}
                </span>
              }
            />
            <KeyValueRow
              label="Relay backend"
              value={backendStatus === 'checking' ? 'Checking…' : backendStatus === 'online' ? 'Available' : 'Unavailable'}
            />
            <KeyValueRow label="Operational incidents" value={openCount} />
          </div>
        </div>
      </div>
    </div>
  );
};
