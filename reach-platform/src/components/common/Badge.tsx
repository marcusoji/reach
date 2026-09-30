import React from 'react';

export type BadgeVariant =
  | 'verifying'
  | 'responding'
  | 'success'
  | 'on-duty'
  | 'active'
  | 'healthy'
  | 'grace'
  | 'danger'
  | 'inactive'
  | 'unhealthy'
  | 'resolved'
  | 'pushed';

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ variant, children, className = '' }) => {
  return (
    <span className={`status-badge status-badge--${variant} ${className}`}>
      {children}
    </span>
  );
};
