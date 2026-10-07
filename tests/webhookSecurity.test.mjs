import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleNapCatWebhook } from '../dist/src/webhook.js';
import { setNapCatConfig, setNapCatRuntime } from '../dist/src/runtime.js';

const secret = 'test-only-signing-secret';
const event = { post_type: 'message', message_type: 'private', user_id: 12345, self_id: 67890, message_id: 99, message: '你好', raw_message: '你好' };
function setup() {
  const received = [];
  setNapCatConfig({ webhookSecret: secret, allowUsers: ['12345'], enableInboundLogging: false, enablePrivateTypingStatus: false, conversationConfigDir: '' });
  setNapCatRuntime({ config: { current: () => ({}) }, channel: {
    routing: { resolveAgentRoute: () => ({ agentId: 'main', sessionKey: 'test', accountId: 'default' }) },
    reply: { createReplyDispatcher: () => ({}), dispatchReplyFromConfig: async ({ ctx }) => received.push(ctx) },
  } });
  return received;
}
async function invoke(body, signingSecret = secret, signedBody) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = Readable.from([raw.subarray(0, raw.length - 2), raw.subarray(raw.length - 2)]);
  Object.assign(req, { url: '/napcat', method: 'POST', headers: signingSecret === null ? {} : { 'x-signature': 'sha1=' + createHmac('sha1', signingSecret).update(signedBody ?? raw).digest('hex') } });
  const res = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
  await handleNapCatWebhook(req, res);
  return res;
}
test('webhook fails closed for missing secret or invalid/missing signatures', async () => {
  const received = setup();
  for (const key of [null, 'wrong-secret']) assert.equal((await invoke(event, key)).statusCode, 403);
  assert.equal((await invoke(event, secret, '{}')).statusCode, 403);
  assert.equal(received.length, 0);
  setNapCatConfig({});
  assert.equal((await invoke(event)).statusCode, 503);
});
test('valid signature authenticates exact bytes before dispatch', async () => {
  const received = setup();
  assert.equal((await invoke(event)).statusCode, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].Body, '你好');
});
