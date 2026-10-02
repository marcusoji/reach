import React, { useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { FilterPills } from '../../components/common/FilterPills';
import { IncidentCard } from '../../components/incidents/IncidentCard';
import { Button } from '../../components/common/Button';
import { useApp } from '../../context/AppContext';

export const AllIncidentsPage: React.FC = () => {
  const { incidents, assessIncident } = useApp();
  const [filter, setFilter] = useState<string>('all');
  const [assessing, setAssessing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

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

  const runAssessment = async (id: string) => {
    setAssessing(id);
    setNotice(null);
    const result = await assessIncident(id);
    setAssessing(null);
    setNotice(
      result
        ? { id, text: `Assessment recorded: ${result.category} · ${Number(result.confidence || 0).toFixed(1)}% · ${result.decision}${result.abstain ? ' (abstained)' : ''}` }
        : { id, text: 'Assessment could not be recorded. The backend may be unavailable.' },
    );
  };

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
            <div key={incident.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <IncidentCard
                incident={incident}
                actionSlot={
                  <Button
                    variant="outline"
                    disabled={assessing === incident.id}
                    onClick={() => void runAssessment(incident.id)}
                  >
                    {assessing === incident.id ? 'Assessing…' : 'Run AI assessment'}
                  </Button>
                }
              />
              {notice?.id === incident.id && (
                <p style={{ fontSize: '0.8rem', color: 'var(--reach-text-secondary)', paddingLeft: '0.25rem' }}>{notice.text}</p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
