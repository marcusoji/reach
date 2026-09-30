import React from 'react';

export interface ReachLogoProps {
  size?: number | string;
  width?: number | string;
  height?: number | string;
  className?: string;
  variant?: 'red' | 'white';
}

/**
 * ReachLogo renders the official REACH shield-and-checkmark SVG logo
 * identical to the REACH mobile application.
 */
export const ReachLogo: React.FC<ReachLogoProps> = ({
  size = 24,
  width,
  height,
  className = '',
  variant = 'red',
}) => {
  const w = width ?? size;
  const h = height ?? size;

  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="REACH Logo"
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
    >
      <path
        d="M12 2L3 7V12C3 16.5 6.8 20.7 12 22C17.2 20.7 21 16.5 21 12V7L12 2Z"
        fill={variant === 'white' ? '#FFFFFF' : '#C81E1E'}
      />
      <path
        d="M9 12.5L11 14.5L15.5 9.5"
        stroke={variant === 'white' ? '#C81E1E' : '#FFFFFF'}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
