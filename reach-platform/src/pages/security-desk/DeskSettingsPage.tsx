import React from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { KeyValueRow } from '../../components/common/KeyValueRow';
import { useApp } from '../../context/AppContext';

/**
 * There is no per-desk settings table yet, so every value here would be invented. The page states
 * that plainly instead of showing a working-looking toggle and radio channel that nothing reads.
 */
export const DeskSettingsPage: React.FC = () => {
  const { staff } = useApp();
  const onDuty = staff.filter((m) => m.status === 'On Duty').length;

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
            label={<span style={{ fontWeight: 600 }}>Responders on duty</span>}
            value={<span>{onDuty}</span>}
          />
          <KeyValueRow
            label={<span style={{ fontWeight: 600 }}>AI auto-push</span>}
            value={<span style={{ color: 'var(--reach-text-secondary)' }}>Not configurable — every assessment is reviewed by a human before action.</span>}
          />
          <KeyValueRow
            label={<span style={{ fontWeight: 600 }}>Radio channel</span>}
            value={<span style={{ color: 'var(--reach-text-secondary)' }}>Not configured — REACH relays over Bluetooth and Wi-Fi, not radio.</span>}
          />
        </div>
        <p style={{ color: 'var(--reach-text-secondary)', marginTop: '1rem', fontSize: '0.9rem' }}>
          Per-desk settings are not persisted yet. These values are not editable because nothing reads them.
        </p>
      </div>
    </div>
  );
};
