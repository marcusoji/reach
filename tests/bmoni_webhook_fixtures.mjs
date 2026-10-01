#!/usr/bin/env node
/**
 * Build signed BMONI webhook fixtures for sandbox certification.
 * Usage:
 *   BMONI_WEBHOOK_SECRET=hexsecret node tests/bmoni_webhook_fixtures.mjs
 */
import { createHmac, randomUUID } from 'crypto';

const secret = process.env.BMONI_WEBHOOK_SECRET || 'test-secret-replace-me';

function sign(body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function event(type, payload) {
  const bodyObj = {
    id: randomUUID(),
    eventType: type,
    payload,
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify(bodyObj);
  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': sign(body),
      'X-Webhook-Id': bodyObj.id,
    },
    body,
  };
}

const fixtures = {
  success: event('payment.completed', { status: 'successful', proposalId: 'prop_test_1', amount: '1000.00' }),
  failed: event('payment.failed', { status: 'failed', proposalId: 'prop_test_2' }),
  invalid_sig: (() => {
    const f = event('payment.completed', { status: 'successful' });
    f.headers['X-Webhook-Signature'] = '00'.repeat(32);
    return f;
  })(),
  duplicate: null,
};

fixtures.duplicate = fixtures.success; // same id replayed by caller

console.log(JSON.stringify(fixtures, null, 2));
console.log('\n# curl example');
console.log(`curl -s -X POST "$REACH_API/webhooks/bmoni" \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Signature: ${fixtures.success.headers['X-Webhook-Signature']}" \\
  -H "X-Webhook-Id: ${fixtures.success.headers['X-Webhook-Id']}" \\
  -d '${fixtures.success.body}'`);
