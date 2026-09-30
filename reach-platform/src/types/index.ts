/* ==========================================================================
   REACH TypeScript Type Definitions
   ========================================================================== */

export type Role = 'citizen' | 'security-desk' | 'staff' | 'institution' | 'operator' | 'super-admin';

export interface AuthUser {
  id?: string;
  email: string;
  name: string;
  role: Role;
  inst?: string;
}

export interface InstitutionSignupData {
  type: 'institution';
  name: string;
  email: string;
  pass: string;
  org: string;
  category?: string;
  city?: string;
  people?: number;
}

export interface StaffSignupData {
  type: 'staff';
  name: string;
  email: string;
  pass: string;
  invite: string;
  roleMap: 'staff' | 'security-desk';
}

export interface OperatorSignupData {
  type: 'operator';
  name: string;
  email: string;
  pass: string;
  key: string;
}

export type SignupData =
  | InstitutionSignupData
  | StaffSignupData
  | OperatorSignupData;

export type IncidentStatus = 'Reported' | 'Received' | 'Verifying' | 'Verified' | 'Assigned' | 'Responding' | 'On Scene' | 'Resolved' | 'Closed' | 'Pushed';

export interface Incident {
  id: string;
  code: string;
  type: string;
  category: 'MEDICAL' | 'FIRE' | 'SECURITY' | 'ACCIDENT' | 'OTHER';
  location: string;
  aiDetails: {
    channel: string;
    confidence: number;
    fpCode: string;
    autoPushed: boolean;
    viaRelay: boolean;
  };
  status: IncidentStatus;
  timestamp: string;
  evidence: {
    audio: boolean;
    image: boolean;
    location: boolean;
  };
  assignedStaff?: string;
}

export interface StaffMember {
  id: string;
  userId?: string;
  role: string;
  name: string;
  status: 'On Duty' | 'On Task' | 'Off Duty';
}

export interface StaffTaskChecklistItem {
  id: string;
  label: string;
  completed: boolean;
}

export interface StaffTask {
  id: string;
  incidentId: string;
  incidentCode: string;
  location: string;
  aiSummary: string;
  status: 'Assigned' | 'Accepted' | 'Responding' | 'Verifying' | 'On Scene' | 'Resolved';
  checklist: StaffTaskChecklistItem[];
}

export interface InstitutionItem {
  id: string;
  code: string;
  name: string;
  category: string;
  plan: string;
  status: 'Active' | 'Grace' | 'Inactive';
  coverageCount: number;
  residentsCount: number;
  staffCount: number;
  securityCount: number;
  nextCharge: string;
  paymentApi: string;
  gracePeriod: string;
}

export interface PaymentRecord {
  id: string;
  date: string;
  code: string;
  status: 'Paid' | 'Pending' | 'Failed';
  amount?: string;
}

export interface NotificationItem {
  id: string;
  date: string;
  text: string;
}

export interface SystemHealthItem {
  id: string;
  service: string;
  status: 'Healthy' | 'Unhealthy' | 'Degraded';
}

export interface AuditLogItem {
  id: string;
  time: string;
  actor: string;
  action: string;
}

export interface LiveFeedItem {
  id: string;
  time: string;
  message: string;
}

export interface AiDecisionItem {
  id: string;
  code: string;
  description: string;
}

export interface DeskSettings {
  teamOnDuty: string;
  aiAutoPush: boolean;
  relayPackets: string;
  radioChannel: string;
}
