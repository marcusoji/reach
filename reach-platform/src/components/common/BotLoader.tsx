import React from 'react';
// The robot's CSS (`.robot*` classes and the bob/blink/ant keyframes) is defined here. Importing it
// explicitly keeps the loader working even if the auth page is ever code-split away.
import '../../styles/auth.css';

/**
 * The REACH boot robot, reused as an in-app loading indicator.
 *
 * It is purely presentational: the caller decides when it shows, so it can never be used to stall a
 * page for a fixed time. The robot's CSS lives in `styles/auth.css` (the `.robot*` classes and the
 * `bob`/`blink`/`ant` keyframes) and is not scoped to the boot screen, so it renders anywhere.
 */
export const BotLoader: React.FC<{ label?: string; sub?: string }> = ({
  label = 'Loading…',
  sub = 'Fetching live REACH data.',
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
    <div
      style={{
        background: '#141211',
        borderRadius: 18,
        padding: '1rem 1.5rem 0.25rem',
        display: 'inline-flex',
        justifyContent: 'center',
      }}
      aria-hidden="true"
    >
      <div className="robot-wrap" style={{ marginBottom: 0 }}>
        <div className="robot">
          <div className="r-ant" />
          <div className="r-head">
            <div className="r-eye l" />
            <div className="r-eye r" />
          </div>
          <div className="r-body">
            <div className="r-badge">AI</div>
            <div className="r-arm l" />
            <div className="r-arm r" />
            <div className="r-leg l" />
            <div className="r-leg r" />
          </div>
        </div>
      </div>
    </div>
    <div style={{ textAlign: 'center' }}>
      <p style={{ fontWeight: 800 }}>{label}</p>
      <p style={{ color: 'var(--reach-text-secondary)', marginTop: 4 }}>{sub}</p>
    </div>
  </div>
);
