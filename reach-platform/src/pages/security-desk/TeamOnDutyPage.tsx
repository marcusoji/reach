import React from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { setMyResponderStatus,isBackendConfigured } from '../../lib/reachApi';
import { Button } from '../../components/common/Button';

export const TeamOnDutyPage: React.FC = () => {
  const { staff, refreshIncidents } = useApp();
  const { user } = useAuth();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow="Security Desk"
        title="Team On Duty"
        subtitle="Responders registered for this institution and their current duty status."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {staff.map((member) => (
          <div
            key={member.id}
            className="reach-card"
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <p style={{ color: 'var(--reach-text-secondary)', fontSize: '0.95rem' }}>
                {member.role}
              </p>
              <p
                style={{
                  fontSize: '1.5rem',
                  fontWeight: 900,
                  color: 'var(--reach-text-primary)',
                }}
              >
                {member.name}
              </p>
            </div>
            <Badge
              variant={
                member.status === 'On Duty'
                  ? 'on-duty'
                  : member.status === 'On Task'
                  ? 'responding'
                  : 'danger'
              }
            >
              {member.status}
            </Badge>
            {user?.id === member.userId && isBackendConfigured && <Button variant="ghost" onClick={()=>void setMyResponderStatus(member.status==='On Duty'?'off_duty':'on_duty').then(()=>refreshIncidents())}>{member.status==='On Duty'?'Go off duty':'Go on duty'}</Button>}
          </div>
        ))}
      </div>
    </div>
  );
};
