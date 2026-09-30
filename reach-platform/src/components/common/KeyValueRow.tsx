import React from 'react';

interface KeyValueRowProps {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}

export const KeyValueRow: React.FC<KeyValueRowProps> = ({
  label,
  value,
  className = '',
}) => {
  return (
    <div className={`key-value-row ${className}`}>
      <div className="key-value-row__key">{label}</div>
      <div className="key-value-row__value">{value}</div>
    </div>
  );
};
