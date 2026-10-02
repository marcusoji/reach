import React, { useEffect, useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { StatCard } from '../../components/common/StatCard';
import { Badge, BadgeVariant } from '../../components/common/Badge';
import { getAiAssessments, isBackendConfigured } from '../../lib/reachApi';

interface AssessmentMetadata {
  abstain?: boolean;
  reasons?: string[];
  model_used?: boolean;
  model_agreement?: 'agree' | 'disagree' | 'none';
  model_category?: string | null;
  model_confidence?: number | null;
  model_evidence_labels?: string[];
  decision_basis?: { blockers?: string[] };
}

interface Assessment {
  id: string;
  incident_id: string;
  model_name?: string;
  category?: string | null;
  confidence?: number | null;
  fp_code?: string | null;
  decision?: string;
  metadata?: AssessmentMetadata;
}

const agreementVariant = (agreement?: string): BadgeVariant => {
  if (agreement === 'agree') return 'success';
  if (agreement === 'disagree') return 'danger';
  return 'inactive';
};

const agreementLabel = (agreement?: string) => {
  if (agreement === 'agree') return 'Model agrees';
  if (agreement === 'disagree') return 'Model disagrees';
  return 'No second opinion';
};

export const AiPerformancePage: React.FC = () => {
  const [items, setItems] = useState<Assessment[]>([]);

  useEffect(() => {
    if (isBackendConfigured) {
      void getAiAssessments().then((r) => setItems((r.data || []) as Assessment[])).catch(() => undefined);
    }
  }, []);

  const avg = items.length ? items.reduce((s, x) => s + Number(x.confidence || 0), 0) / items.length : 0;
  // The engine emits only 'assist' or 'recommend' -- it is designed never to take an autonomous
  // action -- so a share of autonomous pushes was structurally always 0%. Report how often a second
  // opinion was actually obtained and, of those, how often it matched the engine.
  const withModel = items.filter((x) => x.metadata?.model_agreement === 'agree' || x.metadata?.model_agreement === 'disagree');
  const agreed = withModel.filter((x) => x.metadata?.model_agreement === 'agree').length;
  const agreementRate = withModel.length ? (agreed / withModel.length) * 100 : 0;
  const coverage = items.length ? (withModel.length / items.length) * 100 : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow="SAAS OPERATOR"
        title="AI Performance"
        subtitle="Read-only evidence and assessment telemetry. AI assists; human responders remain responsible for operational decisions."
      />

      <div className="stat-card-grid">
        <StatCard label="Assessments" value={items.length} />
        <StatCard label="Second opinion obtained" value={`${coverage.toFixed(0)}%`} compact />
        <StatCard label="Model agreement" value={withModel.length ? `${agreementRate.toFixed(0)}%` : '—'} compact />
        <StatCard label="Avg confidence" value={avg ? `${avg.toFixed(1)}%` : '—'} compact />
      </div>

      <div className="desktop-two-col">
        <div className="reach-card" style={{ padding: '1.5rem', gap: '1.25rem' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>Assessment rules</h2>
          <div className="key-value-list" style={{ padding: 0 }}>
            <p>
              The deterministic engine decides. An external model may contribute a second opinion with a
              bounded weight, and can never promote an assessment to an autonomous action. No client is
              allowed to promote an assessment into an incident decision without the server-side workflow.
            </p>
          </div>
        </div>

        <div className="reach-card" style={{ padding: '1.5rem', gap: '1.25rem' }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>Recent assessments</h2>
          <div className="key-value-list" style={{ padding: 0 }}>
            {items.length === 0 ? (
              <p>No AI assessments have been recorded.</p>
            ) : (
              items.map((x) => (
                <div
                  key={x.id}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.6rem 0', borderBottom: '1px solid var(--reach-border-subtle)' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, color: 'var(--reach-brand)' }}>
                      {x.fp_code || x.incident_id.slice(0, 8)}
                    </span>
                    <span style={{ fontWeight: 600 }}>
                      {x.category || 'Unclassified'} · {Number(x.confidence || 0).toFixed(1)}% · {x.decision}
                    </span>
                    <Badge variant={agreementVariant(x.metadata?.model_agreement)}>
                      {agreementLabel(x.metadata?.model_agreement)}
                    </Badge>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--reach-text-secondary)' }}>
                    {x.metadata?.model_used && x.metadata?.model_category ? (
                      <>
                        Second opinion: {x.metadata.model_category} ·{' '}
                        {Number(x.metadata.model_confidence ?? 0).toFixed(1)}%
                        {x.metadata.model_evidence_labels?.length
                          ? ` · ${x.metadata.model_evidence_labels.join(', ')}`
                          : ''}
                      </>
                    ) : (
                      'No second opinion was used for this assessment; the deterministic engine alone decided.'
                    )}
                  </div>
                  {x.metadata?.abstain && x.metadata?.decision_basis?.blockers?.length ? (
                    <div style={{ fontSize: '0.8rem', color: 'var(--reach-text-muted)' }}>
                      Abstained: {x.metadata.decision_basis.blockers.join(', ')}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

