import React from 'react';

export type ButtonVariant = 'primary' | 'dark' | 'outline' | 'ghost';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  children,
  className = '',
  ...props
}) => {
  return (
    <button
      className={`reach-button reach-button--${variant} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
