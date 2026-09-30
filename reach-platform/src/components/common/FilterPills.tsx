import React from 'react';

interface FilterOption {
  id: string;
  label: string;
  count?: number;
}

interface FilterPillsProps {
  options: FilterOption[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export const FilterPills: React.FC<FilterPillsProps> = ({
  options,
  activeId,
  onChange,
  className = '',
}) => {
  return (
    <div className={`filter-pills ${className}`} role="tablist">
      {options.map((option) => {
        const isActive = option.id === activeId;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`filter-pills__item ${
              isActive ? 'filter-pills__item--active' : ''
            }`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
            {option.count !== undefined && ` (${option.count})`}
          </button>
        );
      })}
    </div>
  );
};
