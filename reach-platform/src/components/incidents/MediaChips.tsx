import React, { useState } from 'react';

interface MediaChipsProps {
  evidence: {
    audio: boolean;
    image: boolean;
    location: boolean;
  };
}

export const MediaChips: React.FC<MediaChipsProps> = ({ evidence }) => {
  const [activeMedia, setActiveMedia] = useState<string | null>(null);

  const chips = [
    { id: 'audio', label: 'Audio Clip', available: evidence.audio, icon: '🔊' },
    { id: 'image', label: 'Image', available: evidence.image, icon: '📷' },
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
            <p><strong>Audio Telemetry:</strong> 911 Call Audio Stream #8841-A (Decoded 16kHz, ambient scream & siren detected).</p>
          )}
          {activeMedia === 'image' && (
            <p><strong>Captured Image:</strong> CCTV Feed Cam-04 Lobby West (AI confidence bbox 0.89 person on floor).</p>
          )}
          {activeMedia === 'location' && (
            <p><strong>Geofence:</strong> Lat 6.5244, Lng 3.3792 · Greenfield Estate Block 24 Ground Level.</p>
          )}
        </div>
      )}
    </div>
  );
};
