/**
 * k6 load script — concurrent incident creates
 * k6 run -e API_URL=... -e TOKEN=... -e VUS=100 tests/load_incidents_k6.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
  },
};

const API = __ENV.API_URL;
const TOKEN = __ENV.TOKEN;

export default function () {
  const res = http.post(
    `${API}/incidents`,
    JSON.stringify({
      category: 'security',
      title: 'Load test incident',
      description: 'k6 generated',
      priority: 'high',
      source_channel: 'web',
    }),
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        apikey: __ENV.ANON || '',
        'Content-Type': 'application/json',
        'x-idempotency-key': `${__VU}-${__ITER}-${Date.now()}`,
      },
    }
  );
  check(res, { 'status 201/200': (r) => r.status === 200 || r.status === 201 });
  sleep(0.2);
}
