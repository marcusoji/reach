import React from 'react';
import { BotLoader } from './BotLoader';

/**
 * Placeholder shown while the shared app data is still loading.
 *
 * Pages that read `institutions[0]` used to render "Institution data unavailable" during the
 * first fetch, which reads as a failed setup/connection even though the data simply had not
 * arrived yet. This keeps that state honest: it is "loading", not "unavailable".
 */
export const LoadingPanel: React.FC<{ label?: string }> = ({ label = 'Loading…' }) => (
  <div className="reach-card" style={{ padding: '2rem' }}>
    <BotLoader label={label} />
  </div>
);
