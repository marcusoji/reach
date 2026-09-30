import React from 'react';
import { Link } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { ReachLogo } from '../components/common/ReachLogo';

interface MobileHeaderProps {
  onToggleSidebar: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({ onToggleSidebar }) => {
  return (
    <header className="mobile-header">
      <Link to="/" className="mobile-header__logo" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <ReachLogo size={24} />
        <span>REACH</span>
      </Link>
      <button
        type="button"
        className="mobile-header__toggle"
        onClick={onToggleSidebar}
        aria-label="Toggle Navigation Menu"
      >
        <Menu size={24} />
      </button>
    </header>
  );
};
