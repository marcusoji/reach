import React, { useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { FilterPills } from '../../components/common/FilterPills';
import { IncidentCard } from '../../components/incidents/IncidentCard';
import { useApp } from '../../context/AppContext';

export const AllIncidentsPage: React.FC = () => {
  const { incidents } = useApp();
  const [filter, setFilter] = useState<string>('all');

  const filterOptions = [
    { id: 'all', label: 'All' },
    { id: 'Verifying', label: 'Verifying' },
    { id: 'Responding', label: 'Responding' },
    { id: 'Resolved', label: 'Resolved' },
    { id: 'On Scene', label: 'On Scene' },
  ];

  const filteredIncidents = incidents.filter((inc) => {
    if (filter === 'all') return true;
    return inc.status === filter;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow="SAAS OPERATOR"
        title="All Incidents"
        subtitle="Read-only platform monitor. Routing is handled autonomously from AI → local desk."
      />

      <FilterPills
        options={filterOptions}
        activeId={filter}
        onChange={setFilter}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {filteredIncidents.length === 0 ? (
          <div className="reach-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
            <p style={{ color: 'var(--reach-text-secondary)', fontWeight: 600 }}>
              No platform incidents matching status "{filter}".
            </p>
          </div>
        ) : (
          filteredIncidents.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))
        )}
      </div>
    </div>
  );
};
