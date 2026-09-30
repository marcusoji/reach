import React, { useState } from 'react';
import { SectionHeader } from '../../components/common/SectionHeader';
import { StatCard } from '../../components/common/StatCard';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';

export const StaffTasksPage: React.FC = () => {
  const { staffTasks, toggleTaskChecklist, advanceTaskStatus } = useApp();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'todo' | 'responded'>('todo');

  const openTasksCount = staffTasks.filter(
    (t) => t.status !== 'Resolved'
  ).length;

  const filteredTasks = staffTasks.filter((task) => {
    if (activeTab === 'todo') {
      return task.status === 'Assigned' || task.status === 'Accepted' || task.status === 'Responding' || task.status === 'Verifying';
    }
    return task.status === 'On Scene' || task.status === 'Resolved';
  });

  const handleOnSceneClick = (taskId: string, incidentId: string) => {
    advanceTaskStatus(taskId, 'On Scene');
    void incidentId;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <SectionHeader
        eyebrow="Response Staff"
        title="My Tasks"
        subtitle="Tasks appear after security desk Accept. Review evidence, confirm on-scene arrival, and report status."
      />

      {/* Staff Task Stats */}
      <div className="stat-card-grid">
        <StatCard label="Open Tasks" value={openTasksCount} />
        <StatCard label="Responder" value={user?.name || "—"} compact />
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          type="button"
          onClick={() => setActiveTab('todo')}
          style={{
            border: 'none',
            padding: '0.6rem 1.5rem',
            borderRadius: 'var(--reach-radius-md)',
            cursor: 'pointer',
            fontWeight: 700,
            background: activeTab === 'todo' ? 'var(--reach-text-primary)' : 'var(--reach-bg-surface)',
            color: activeTab === 'todo' ? 'var(--reach-text-inverse)' : 'var(--reach-text-primary)',
            boxShadow: 'var(--reach-shadow-sm)',
            transition: 'all 0.15s ease',
          }}
        >
          To-do
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('responded')}
          style={{
            border: 'none',
            padding: '0.6rem 1.5rem',
            borderRadius: 'var(--reach-radius-md)',
            cursor: 'pointer',
            fontWeight: 700,
            background: activeTab === 'responded' ? 'var(--reach-text-primary)' : 'var(--reach-bg-surface)',
            color: activeTab === 'responded' ? 'var(--reach-text-inverse)' : 'var(--reach-text-primary)',
            boxShadow: 'var(--reach-shadow-sm)',
            transition: 'all 0.15s ease',
          }}
        >
          Responded
        </button>
      </div>

      {/* Task List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {filteredTasks.length === 0 ? (
          <div className="reach-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
            <p style={{ color: 'var(--reach-text-secondary)', fontWeight: 600 }}>
              No tasks currently in the "{activeTab === 'todo' ? 'To-do' : 'Responded'}" queue.
            </p>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <div key={task.id} className="reach-card" style={{ gap: '1.5rem' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: '1rem',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <p style={{ color: 'var(--reach-text-secondary)', fontWeight: 600 }}>
                    {task.incidentCode}
                  </p>
                  <h2
                    style={{
                      fontSize: '1.75rem',
                      fontWeight: 900,
                      color: 'var(--reach-text-primary)',
                    }}
                  >
                    {task.location}
                  </h2>
                  <p
                    style={{
                      color: 'var(--reach-text-secondary)',
                      fontFamily: 'monospace',
                      fontSize: '0.9rem',
                    }}
                  >
                    {task.aiSummary}
                  </p>
                </div>

                <Badge
                  variant={
                    task.status === 'Responding'
                      ? 'responding'
                      : task.status === 'On Scene'
                      ? 'success'
                      : 'verifying'
                  }
                >
                  {task.status}
                </Badge>
              </div>

              {/* Assignment acceptance and response controls */}
              {(task.status === 'Assigned' || task.status === 'Accepted') && (
                <div style={{display:'flex',gap:'0.75rem',flexWrap:'wrap',paddingTop:'1rem',borderTop:'1px solid var(--reach-border-card)'}}>
                  {task.status === 'Assigned' && <Button variant="primary" onClick={() => advanceTaskStatus(task.id, 'Accepted')}>Accept assignment</Button>}
                  {task.status === 'Accepted' && <Button variant="primary" onClick={() => advanceTaskStatus(task.id, 'Responding')}>Start response</Button>}
                </div>
              )}

              {/* Action Checklist & On Scene Button */}
              {task.status === 'Responding' && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1.25rem',
                    paddingTop: '1rem',
                    borderTop: '1px solid var(--reach-border-card)',
                  }}
                >
                  <div className="task-checklist">
                    {task.checklist.map((item) => (
                      <label key={item.id} className="task-checklist__item">
                        <input
                          type="checkbox"
                          className="task-checklist__input"
                          checked={item.completed}
                          onChange={() => toggleTaskChecklist(task.id, item.id)}
                        />
                        <span
                          className="task-checklist__label"
                          style={{
                            textDecoration: item.completed ? 'line-through' : 'none',
                            color: item.completed ? 'var(--reach-text-muted)' : 'inherit',
                          }}
                        >
                          {item.label}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div>
                    <Button
                      variant="primary"
                      onClick={() => handleOnSceneClick(task.id, task.incidentId)}
                    >
                      I’m On Scene
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
