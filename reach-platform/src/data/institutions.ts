import { InstitutionItem, PaymentRecord, NotificationItem } from '../types';

export const INITIAL_INSTITUTIONS: InstitutionItem[] = [
  {
    id: 'ins-0124',
    code: 'INS-0124',
    name: 'Greenfield Estate',
    category: 'Estate',
    plan: 'REACH Full',
    status: 'Active',
    coverageCount: 762,
    residentsCount: 683,
    staffCount: 54,
    securityCount: 25,
    nextCharge: '1 OCT 2026',
    paymentApi: 'BMONI Embedded',
    gracePeriod: '7 Days',
  },
  {
    id: 'ins-0125',
    code: 'INS-0125',
    name: 'Unity Secondary',
    category: 'Educational Institution',
    plan: 'REACH Full',
    status: 'Grace',
    coverageCount: 1240,
    residentsCount: 1100,
    staffCount: 95,
    securityCount: 45,
    nextCharge: '24 SEP 2026',
    paymentApi: 'BMONI Embedded',
    gracePeriod: '3 Days Remaining',
  },
  {
    id: 'ins-0126',
    code: 'INS-0126',
    name: 'Harbor Clinic',
    category: 'Health Institution',
    plan: 'No active plan',
    status: 'Inactive',
    coverageCount: 320,
    residentsCount: 0,
    staffCount: 320,
    securityCount: 12,
    nextCharge: 'EXPIRED',
    paymentApi: 'BMONI Embedded',
    gracePeriod: '0 Days',
  },
];

export const INITIAL_PAYMENT_HISTORY: PaymentRecord[] = [
  {
    id: 'pay-1',
    date: '20 September 2026',
    code: 'PAY-1042-60',
    status: 'Paid',
    amount: '$1,450.00',
  },
  {
    id: 'pay-2',
    date: '19 August 2026',
    code: 'PAY-1042-60',
    status: 'Paid',
    amount: '$1,450.00',
  },
];

export const INITIAL_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'notif-1',
    date: 'Monday',
    text: 'Maintenance update from 12:00PM',
  },
  {
    id: 'notif-2',
    date: '26 August 2026',
    text: 'Receipt for payment',
  },
  {
    id: 'notif-3',
    date: '20 August 2026',
    text: 'Reminder to update subscription',
  },
  {
    id: 'notif-4',
    date: '1 August 2026',
    text: 'Happy New Month',
  },
];
