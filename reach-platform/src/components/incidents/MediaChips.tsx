import React, { useState } from 'react';

interface MediaChipsProps {
  evidence: {
    audio: boolean;
    image: boolean;
    video?: boolean;
    location: boolean;
  };
  /** The incident's recorded location label, if any. Shown verbatim — never invented. */
  locationLabel?: string | null;
}

/**
 * Evidence chips for the active incident. The chips only report what the incident record actually
 * carries: a chip is available when the corresponding evidence is attached, and opening it explains
 * how to review that evidence. The panel deliberately does not describe footage, telemetry or a
 * geofence that the desk has not been shown — an operator acting on a fabricated CCTV summary would
 * be worse than no summary at all.
 */
export const MediaChips: React.FC<MediaChipsProps> = ({ evidence, locationLabel }) => {
  const [activeMedia, setActiveMedia] = useState<string | null>(null);

  const chips = [
    { id: 'audio', label: 'Audio Clip', available: evidence.audio, icon: '🔊' },
    { id: 'image', label: 'Image', available: evidence.image, icon: '📷' },
    { id: 'video', label: 'Video', available: Boolean(evidence.video), icon: '🎥' },
    { id: 'location', label: 'Location', available: evidence.location, icon: '📍' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className="media-chips">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`media-chip ${activeMedia === chip.id ? 'media-chip--active' : ''}`}
            onClick={() =>
              setActiveMedia(activeMedia === chip.id ? null : chip.id)
            }
          >
            <span>{chip.icon}</span>
            <span>{chip.label}</span>
          </button>
        ))}
      </div>

      {activeMedia && (
        <div
          style={{
            background: 'var(--reach-bg-surface)',
            border: '1px solid var(--reach-border-subtle)',
            borderRadius: 'var(--reach-radius-md)',
            padding: '1rem',
            fontSize: '0.9rem',
            color: 'var(--reach-text-secondary)',
          }}
        >
          {activeMedia === 'audio' && (
            <p>
              {evidence.audio
                ? 'An audio clip is attached to this incident. Open the incident record to review it.'
                : 'No audio clip is attached to this incident.'}
            </p>
          )}
          {activeMedia === 'image' && (
            <p>
              {evidence.image
                ? 'An image is attached to this incident. Open the incident record to review it.'
                : 'No image is attached to this incident.'}
            </p>
          )}
          {activeMedia === 'video' && (
            <p>
              {evidence.video
                ? 'A video clip is attached to this incident. Open the incident record to review it.'
                : 'No video clip is attached to this incident.'}
            </p>
          )}
          {activeMedia === 'location' && (
            <p>
              {locationLabel
                ? <>Recorded location: <strong>{locationLabel}</strong>.</>
                : 'No location is recorded for this incident.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
