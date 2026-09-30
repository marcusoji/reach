import React from 'react';
import { ReachLogo } from './ReachLogo';

interface SectionHeaderProps {
  eyebrow?: string;
  tag?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
  showLogo?: boolean;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  eyebrow,
  tag,
  title,
  subtitle,
  actions,
  className = '',
  showLogo = true,
}) => {
  return (
    <div className={`page-intro ${className}`}>
      {(eyebrow || tag) && (
        <div className="page-intro__eyebrow">
          {showLogo && <ReachLogo size={20} />}
          {eyebrow && <span>{eyebrow}</span>}
          {tag && <span className="page-intro__tag">{tag}</span>}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div className="page-intro__title-group">
          <h1 className="page-intro__title">{title}</h1>
          {subtitle && <p className="page-intro__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-intro__actions">{actions}</div>}
      </div>
    </div>
  );
};
