import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SectionHeader } from '../../components/common/SectionHeader';
import { StatCard } from '../../components/common/StatCard';
import { FilterPills } from '../../components/common/FilterPills';
import { IncidentCard } from '../../components/incidents/IncidentCard';
import { useApp } from '../../context/AppContext';
import { IncidentStatus } from '../../types';

export const LiveQueuePage: React.FC = () => {
  const navigate = useNavigate();
  const { incidents } = useApp();
  const [selectedFilter, setSelectedFilter] = useState<string>('all');

  // Dynamic metric calculations
  const openCount = incidents.filter((inc) => !['Resolved', 'Closed'].includes(inc.status)).length;
  const autoPushedCount = incidents.filter((inc) => inc.aiDetails.autoPushed).length;
  const viaRelayCount = incidents.filter((inc) => inc.aiDetails.viaRelay).length;

  const filterOptions = [
    { id: 'all', label: 'All' },
    { id: 'Verifying', label: 'Verifying' },
    { id: 'Responding', label: 'Responding' },
    { id: 'Resolved', label: 'Resolved' },
    { id: 'On Scene', label: 'On Scene' },
  ];

  const filteredIncidents = incidents.filter((inc) => {
    if (selectedFilter === 'all') return true;
    return inc.status === selectedFilter;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow="Security Desk"
        title="Live Queue"
        subtitle="AI-assisted queue. Review evidence, assessment score, relay path and verification state before accepting."
      />

      {/* Metric Cards Grid */}
      <div className="stat-card-grid">
        <StatCard label="Open" value={openCount} />
        <StatCard label="AI Auto Pushed" value={autoPushedCount} />
        <StatCard label="Via relay" value={viaRelayCount} />
      </div>

      {/* Filter Pills */}
      <FilterPills
        options={filterOptions}
        activeId={selectedFilter}
        onChange={setSelectedFilter}
      />

      {/* Incidents Queue List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {filteredIncidents.length === 0 ? (
          <div className="reach-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
            <p style={{ color: 'var(--reach-text-secondary)', fontWeight: 600 }}>
              No incidents matching status "{selectedFilter}".
            </p>
          </div>
        ) : (
          filteredIncidents.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              onClick={() => navigate('/security-desk/response-desk')}
            />
          ))
        )}
      </div>
    </div>
  );
};
