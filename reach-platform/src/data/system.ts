import {
  SystemHealthItem,
  AuditLogItem,
  LiveFeedItem,
  AiDecisionItem,
  DeskSettings,
} from '../types';

export const INITIAL_SYSTEM_HEALTH: SystemHealthItem[] = [
  { id: 'sh-1', service: 'Incident core', status: 'Healthy' },
  { id: 'sh-2', service: 'AI scoring + auto-push', status: 'Healthy' },
  { id: 'sh-3', service: 'Relay ingest', status: 'Unhealthy' },
  { id: 'sh-4', service: 'USSD / SMS / IVR', status: 'Healthy' },
];

export const INITIAL_AUDIT_LOG: AuditLogItem[] = [
  {
    id: 'aud-1',
    time: '09:28',
    actor: 'inst.admin',
    action: 'Desk roster sync completed',
  },
  {
    id: 'aud-2',
    time: '09:24',
    actor: 'inst.admin',
    action: 'Payment PAY-1042-64',
  },
  {
    id: 'aud-3',
    time: '00:24',
    actor: 'desk.zoneB',
    action: 'Desk review · call to confirm · REACH-8842 · FP-4921',
  },
  {
    id: 'aud-4',
    time: '00:10',
    actor: 'ai.pack',
    action: 'Auto-push to desk · REACH-8841 · FP-2928',
  },
];

export const INITIAL_LIVE_FEED: LiveFeedItem[] = [
  {
    id: 'feed-1',
    time: '00:20',
    message: 'REACH-8843 accepted · Zone B',
  },
  {
    id: 'feed-2',
    time: '00:50',
    message: 'REACH-8843 AI → desk · Desk review',
  },
  {
    id: 'feed-3',
    time: '00:53',
    message: 'REACH-8842 AI → desk · Desk review · call to confirm',
  },
];

export const INITIAL_AI_DECISIONS: AiDecisionItem[] = [
  {
    id: 'dec-1',
    code: '8843',
    description: 'Desk review · conf 0.68 · desk push',
  },
  {
    id: 'dec-2',
    code: '8842',
    description: 'Desk review · call to confirm · conf 0.69 · desk push',
  },
  {
    id: 'dec-3',
    code: '8841',
    description: 'Auto-push to desk · conf 0.9 · desk push',
  },
];

export const INITIAL_DESK_SETTINGS: DeskSettings = {
  teamOnDuty: 'Zone B Security',
  aiAutoPush: true,
  relayPackets: 'Accepted after uplink',
  radioChannel: 'CH-3',
};
