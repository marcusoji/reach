import React from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { IncidentCard } from '../../components/incidents/IncidentCard';
import { useApp } from '../../context/AppContext';

export const SiteIncidentsPage: React.FC = () => {
  const { incidents, institutions } = useApp();
  const currentInstitution = institutions[0];
  if (!currentInstitution) return <div className="reach-card" style={{padding:'2rem'}}><h2>Institution data unavailable</h2><p style={{color:'var(--reach-text-secondary)',marginTop:8}}>Connect the REACH backend or finish institution setup to load live data.</p></div>;

  // Incidents for this institution (e.g. Block 24, Block C, East Gate)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow={`Institution - ${currentInstitution.name}`}
        tag={currentInstitution.code}
        title="Site Incidents"
        subtitle="All emergencies and incidents reported or routed within this institution boundary."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {incidents.map((incident) => (
          <IncidentCard key={incident.id} incident={incident} />
        ))}
      </div>
    </div>
  );
};
