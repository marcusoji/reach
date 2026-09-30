import React from 'react';
import { Incident } from '../../types';
import { Badge, BadgeVariant } from '../common/Badge';

interface IncidentCardProps {
  incident: Incident;
  onClick?: () => void;
  actionSlot?: React.ReactNode;
  className?: string;
}

export const IncidentCard: React.FC<IncidentCardProps> = ({
  incident,
  onClick,
  actionSlot,
  className = '',
}) => {
  // Map incident status to badge variant
  const getBadgeVariant = (status: Incident['status']): BadgeVariant => {
    switch (status) {
      case 'Verifying':
        return 'verifying';
      case 'Responding':
        return 'responding';
      case 'On Scene':
        return 'success';
      case 'Resolved':
        return 'resolved';
      case 'Pushed':
        return 'pushed';
      default:
        return 'verifying';
    }
  };

  return (
    <div
      className={`incident-card ${className}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="incident-card__details">
        <p className="incident-card__code">{incident.code}</p>
        <h3 className="incident-card__title">{incident.type}</h3>
        <p className="incident-card__meta">
          AI {incident.status.toUpperCase()} - {incident.aiDetails.channel} - conf{' '}
          {incident.aiDetails.confidence} - {incident.aiDetails.fpCode}
          {incident.aiDetails.viaRelay && ' · via relay'}
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Badge variant={getBadgeVariant(incident.status)}>
          {incident.status}
        </Badge>
        {actionSlot}
      </div>
    </div>
  );
};
