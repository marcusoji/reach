import { StaffMember, StaffTask } from '../types';

export const INITIAL_STAFF: StaffMember[] = [
  {
    id: 'staff-1',
    role: 'Shift lead',
    name: 'Amadi Okonkwo',
    status: 'On Duty',
  },
  {
    id: 'staff-2',
    role: 'Responder',
    name: 'Taiwo Adeleke',
    status: 'On Duty',
  },
  {
    id: 'staff-3',
    role: 'Field Medic',
    name: 'Chioma Eze',
    status: 'On Task',
  },
];

export const INITIAL_STAFF_TASKS: StaffTask[] = [
  {
    id: 'task-1',
    incidentId: 'inc-8841-med',
    incidentCode: 'REACH - 8841',
    location: 'MEDICAL - Block 24 lobby',
    aiSummary: 'AI VERIFYING - weak channel - conf 0.39 - FP-1515',
    status: 'Responding',
    checklist: [
      { id: 'check-1', label: 'Call reporter to confirm', completed: false },
      { id: 'check-2', label: 'Review evidence', completed: false },
      { id: 'check-3', label: 'Assess Scene', completed: false },
    ],
  },
  {
    id: 'task-2',
    incidentId: 'inc-8841-oth',
    incidentCode: 'REACH - 8841',
    location: 'OTHER - Block C lobby',
    aiSummary: 'AI VERIFYING - weak channel - conf 0.39 - FP-1515',
    status: 'Verifying',
    checklist: [
      { id: 'check-4', label: 'Review audio telemetry', completed: true },
      { id: 'check-5', label: 'Dispatch perimeter sweep', completed: false },
    ],
  },
];
