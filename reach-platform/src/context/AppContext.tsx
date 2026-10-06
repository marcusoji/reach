import React, { createContext, useContext, useEffect, useState } from 'react';
import { Incident, IncidentStatus, StaffMember, StaffTask, InstitutionItem, PaymentRecord } from '../types';
import { INITIAL_INCIDENTS } from '../data/incidents';
import { INITIAL_STAFF, INITIAL_STAFF_TASKS } from '../data/staff';
import { INITIAL_INSTITUTIONS, INITIAL_PAYMENT_HISTORY } from '../data/institutions';
import { changeIncidentStatus, changeTaskStatus, getInstitutionSummary, isBackendConfigured, isDemoMode, listIncidents, listResponders, listTasks, runAiAssessment, subscribeToIncidentChanges } from '../lib/reachApi';

interface AppContextType {
  incidents: Incident[];
  updateIncidentStatus: (id: string, status: IncidentStatus) => void;
  // Runs the deterministic assessment for one incident, optionally with a second opinion.
  // Returns the engine's verdict so the caller can surface it; never throws.
  assessIncident: (id: string, payload?: { description?: string; evidence?: any[]; reported_category?: string }) => Promise<any | null>;
  staff: StaffMember[];
  staffTasks: StaffTask[];
  toggleTaskChecklist: (taskId: string, checkId: string) => void;
  advanceTaskStatus: (taskId: string, newStatus: StaffTask['status']) => void;
  institutions: InstitutionItem[];
  paymentHistory: PaymentRecord[];
  recordPayment: (amount?: string) => void;
  backendOnline: boolean;
  dataLoading: boolean;
  refreshIncidents: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);
const statusMap: Record<string, IncidentStatus> = { reported:'Reported', received:'Received', verifying:'Verifying', verified:'Verified', assigned:'Assigned', responding:'Responding', on_scene:'On Scene', resolved:'Resolved', closed:'Closed', cancelled:'Resolved' };

function mapIncident(inc: any): Incident {
  return {
    id: inc.id, code: inc.code, type: inc.title, category: (inc.category || 'other').toUpperCase() as Incident['category'],
    location: inc.location_label || 'Location unavailable',
    aiDetails: { channel: inc.source_channel || 'PWA', confidence: Number(inc.ai_confidence || 0), fpCode: inc.ai_fp_code || '—', autoPushed: Boolean(inc.auto_pushed), viaRelay: Boolean(inc.via_relay) },
    status: statusMap[inc.status] || 'Reported', timestamp: inc.reported_at, evidence: { audio:false, image:false, location:Boolean(inc.location_label) }, assignedStaff: inc.assigned_staff,
  };
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [incidents, setIncidents] = useState<Incident[]>(isBackendConfigured ? [] : (isDemoMode ? INITIAL_INCIDENTS : []));
  const [staff, setStaff] = useState<StaffMember[]>(isBackendConfigured ? [] : (isDemoMode ? INITIAL_STAFF : []));
  const [staffTasks, setStaffTasks] = useState<StaffTask[]>(isBackendConfigured ? [] : (isDemoMode ? INITIAL_STAFF_TASKS : []));
  const [institutions, setInstitutions] = useState<InstitutionItem[]>(isBackendConfigured ? [] : (isDemoMode ? INITIAL_INSTITUTIONS : []));
  const [paymentHistory, setPaymentHistory] = useState<PaymentRecord[]>(isBackendConfigured ? [] : (isDemoMode ? INITIAL_PAYMENT_HISTORY : []));
  const [backendOnline, setBackendOnline] = useState(false);
  // True until the first backend load settles. Pages that need `institutions[0]` must distinguish
  // "still loading" from "this account has no institution" — otherwise a cold reload briefly (and,
  // if the first fetch is slow, for seconds) claims "Institution data unavailable".
  const [dataLoading, setDataLoading] = useState(isBackendConfigured);

  const refreshIncidents = async () => {
    if (!isBackendConfigured) return;
    setDataLoading(true);
    try {
      const [remote, responders, tasks] = await Promise.all([listIncidents(), listResponders().catch(() => ({ data: [] })), listTasks().catch(() => ({ data: [] }))]);
      setIncidents(remote.map(mapIncident));
      setStaff((responders.data || []).map((r: any) => ({ id:r.id, userId:r.user_id, role:r.responder_type || 'Responder', name:r.full_name || r.user_id, status:r.duty_status === 'on_duty' ? 'On Duty' : r.duty_status === 'on_task' ? 'On Task' : 'Off Duty' })));
      setStaffTasks((tasks.data || []).map((t: any) => ({
        id:t.id, incidentId:t.incident_id, incidentCode:t.incident?.code || '—', location:t.incident?.location_label || 'Location unavailable',
        aiSummary:`${String(t.incident?.source_channel || 'PWA').toUpperCase()} · conf ${Number(t.incident?.ai_confidence || 0).toFixed(2)} · ${t.incident?.ai_fp_code || '—'}`,
        status:t.status === 'on_scene' ? 'On Scene' : t.status === 'completed' ? 'Resolved' : t.status === 'responding' ? 'Responding' : t.status === 'accepted' ? 'Accepted' : 'Assigned',
        checklist:[{id:'accept',label:'Accept assignment',completed:['accepted','responding','on_scene','completed'].includes(t.status)},{id:'arrive',label:'Confirm on scene',completed:['on_scene','completed'].includes(t.status)}],
      })));
      // The billing summary is institution-scoped: it 403s for every other role and for an
      // institution with no billing row. That is not "the backend is down", so it is kept out of the
      // outer try — a failure here must not flip the shared `backendOnline` flag to false and make
      // every portal claim the backend is unavailable.
      setBackendOnline(true);
      try {
          const summary = await getInstitutionSummary();
          const inst = summary.data.institution;
          const sub = summary.data.subscription;
          setInstitutions([{ id:inst.id, code:inst.id.slice(0,8).toUpperCase(), name:inst.name, category:inst.category, plan:sub?.plan_name || 'REACH Full', status:sub?.status === 'active' ? 'Active' : sub?.status === 'trial' ? 'Grace' : 'Inactive', coverageCount:summary.data.members.length, residentsCount:summary.data.members.filter((m:any)=>m.membership_role==='citizen').length, staffCount:summary.data.members.filter((m:any)=>m.membership_role==='staff').length, securityCount:summary.data.members.filter((m:any)=>m.membership_role==='security-desk').length, nextCharge:sub?.current_period_end || '—', paymentApi:sub?.provider || 'BMONI Embedded', gracePeriod:sub?.status || 'trial' }]);
          setPaymentHistory((summary.data.payments || []).map((p:any) => ({ id:p.id, date:new Date(p.created_at).toLocaleDateString('en-GB'), code:p.provider_reference || p.id.slice(0,8), status:p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Failed' : 'Pending', amount:p.amount ? `₦${Number(p.amount).toLocaleString()}` : undefined })));
        } catch { /* non-institution roles or unconfigured billing */ }
    } catch { setBackendOnline(false); }
    finally { setDataLoading(false); }
  };

  useEffect(() => {
    void refreshIncidents();
    if (!isBackendConfigured) return;
    const unsubscribe = subscribeToIncidentChanges(() => { void refreshIncidents(); });
    const fallbackTimer = window.setInterval(() => { void refreshIncidents(); }, 60000);
    return () => { unsubscribe(); window.clearInterval(fallbackTimer); };
  }, []);

  const updateIncidentStatus = (id: string, status: IncidentStatus) => {
    if (!isBackendConfigured && isDemoMode) { setIncidents(prev => prev.map(inc => inc.id === id ? { ...inc, status } : inc)); return; }
    const apiStatus = status.toLowerCase().replace(' ', '_');
    void changeIncidentStatus(id, apiStatus).then(() => refreshIncidents()).catch(() => setBackendOnline(false));
  };

  // An assessment costs an external model query when a provider is configured, so this stays an
  // explicit operator action rather than firing on every incident load.
  const assessIncident = async (id: string, payload?: { description?: string; evidence?: any[]; reported_category?: string }) => {
    if (!isBackendConfigured) return null;
    try {
      const res = await runAiAssessment(id, payload);
      await refreshIncidents();
      return res.data ?? null;
    } catch {
      setBackendOnline(false);
      return null;
    }
  };

  const toggleTaskChecklist = (taskId: string, checkId: string) => setStaffTasks(prev => prev.map(task => task.id === taskId ? { ...task, checklist: task.checklist.map(item => item.id === checkId ? { ...item, completed: !item.completed } : item) } : task));
  const advanceTaskStatus = (taskId: string, newStatus: StaffTask['status']) => {
    if (!isBackendConfigured && isDemoMode) { setStaffTasks(prev => prev.map(task => task.id === taskId ? { ...task, status:newStatus } : task)); return; }
    const apiStatus = newStatus === 'On Scene' ? 'on_scene' : newStatus === 'Resolved' ? 'completed' : newStatus === 'Responding' ? 'responding' : 'accepted';
    void changeTaskStatus(taskId, apiStatus).then(() => refreshIncidents()).catch(() => setBackendOnline(false));
  };
  const recordPayment = (amount = '₦1,450,000.00') => { if (!isBackendConfigured && isDemoMode) setPaymentHistory(prev => [{ id:`pay-${Date.now()}`, date:new Date().toLocaleDateString('en-GB'), code:`PAY-${Date.now().toString().slice(-6)}`, status:'Paid', amount }, ...prev]); };
  return <AppContext.Provider value={{ incidents, updateIncidentStatus, assessIncident, staff, staffTasks, toggleTaskChecklist, advanceTaskStatus, institutions, paymentHistory, recordPayment, backendOnline, dataLoading, refreshIncidents }}>{children}</AppContext.Provider>;
};

export const useApp = () => { const context = useContext(AppContext); if (!context) throw new Error('useApp must be used within an AppProvider'); return context; };
