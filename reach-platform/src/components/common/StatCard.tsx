import React from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  compact?: boolean;
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  compact = false,
  className = '',
}) => {
  return (
    <div className={`stat-card ${className}`}>
      <p className="stat-card__label">{label}</p>
      <p className={`stat-card__value ${compact ? 'stat-card__value--compact' : ''}`}>
        {value}
      </p>
    </div>
  );
};
