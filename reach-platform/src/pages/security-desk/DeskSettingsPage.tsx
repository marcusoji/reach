import React from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { useApp } from '../../context/AppContext';

export const DeskSettingsPage: React.FC = () => {
  const { deskSettings, updateDeskSettings } = useApp();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow="Security Desk"
        title="Desk Settings"
        subtitle="Operational parameters and network relay configurations for this security desk."
      />

      <div className="reach-card" style={{ padding: '1.5rem' }}>
        <div className="key-value-list" style={{ padding: 0 }}>
          <KeyValueRow
            label={<span style={{ fontWeight: 600 }}>Team On Duty</span>}
            value={<span>{deskSettings.teamOnDuty}</span>}
          />
          <KeyValueRow
            label={<span style={{ fontWeight: 600 }}>Ai auto-push</span>}
            value={
              <button
                type="button"
                onClick={() =>
                  updateDeskSettings('aiAutoPush', !deskSettings.aiAutoPush)
                }
                style={{
                  background: deskSettings.aiAutoPush
                    ? 'var(--status-success-bg)'
                    : 'var(--status-danger-bg)',
                  color: deskSettings.aiAutoPush
                    ? 'var(--status-success-text)'
                    : 'var(--status-danger-text)',
                  border: 'none',
                  padding: '0.3rem 0.8rem',
                  borderRadius: 'var(--reach-radius-sm)',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {deskSettings.aiAutoPush ? 'Enabled' : 'Disabled'}
              </button>
            }
          />
          <KeyValueRow
            label={<span style={{ fontWeight: 600 }}>Relay Packets</span>}
            value={<span>{deskSettings.relayPackets}</span>}
          />
          <KeyValueRow
            label={<span style={{ fontWeight: 600 }}>Radio</span>}
            value={<span>{deskSettings.radioChannel}</span>}
          />
        </div>
      </div>
    </div>
  );
};
