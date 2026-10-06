import React, { useRef, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { FilterPills } from '../../components/common/FilterPills';
import { IncidentCard } from '../../components/incidents/IncidentCard';
import { Button } from '../../components/common/Button';
import { LoadingPanel } from '../../components/common/LoadingPanel';
import { useApp } from '../../context/AppContext';
import { uploadIncidentEvidence } from '../../lib/reachApi';

export const AllIncidentsPage: React.FC = () => {
  const { incidents, assessIncident, dataLoading } = useApp();
  const [filter, setFilter] = useState<string>('all');
  const [assessing, setAssessing] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

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

  // Captured media is the strongest evidence the engine accepts, so it is worth attaching before
  // running an assessment. The upload must sit under the caller's own uid prefix (server-enforced).
  const attachFile = async (id: string, file: File) => {
    setUploading(id);
    setNotice(null);
    // Only media kinds are accepted from a client. sensor/motion are not something an operator can
    // assert on a citizen's behalf, so an unrelated file is refused rather than mislabelled.
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : null;
    if (!kind) {
      setNotice({ id, text: `Unsupported file type (${file.type || 'unknown'}). Attach a photo, audio or video file.` });
      setUploading(null);
      return;
    }
    try {
      await uploadIncidentEvidence(id, kind, file);
      setNotice({ id, text: `Captured ${kind} attached (${file.name}). Re-run the assessment to fuse it.` });
    } catch (error) {
      setNotice({ id, text: `Evidence upload failed: ${error instanceof Error ? error.message : 'unknown error'}` });
    } finally {
      setUploading(null);
    }
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
        {dataLoading && !incidents.length ? (
          <LoadingPanel label="Loading platform incidents…" />
        ) : filteredIncidents.length === 0 ? (
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
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <input
                      ref={(el) => { fileInputs.current[incident.id] = el; }}
                      type="file"
                      accept="image/*,audio/*,video/*"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void attachFile(incident.id, file);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      variant="outline"
                      disabled={uploading === incident.id}
                      onClick={() => fileInputs.current[incident.id]?.click()}
                    >
                      {uploading === incident.id ? 'Attaching…' : 'Attach evidence'}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={assessing === incident.id}
                      onClick={() => void runAssessment(incident.id)}
                    >
                      {assessing === incident.id ? 'Assessing…' : 'Run AI assessment'}
                    </Button>
                  </div>
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
