import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleNapCatWebhook } from '../dist/src/webhook.js';
import { setNapCatConfig, setNapCatRuntime } from '../dist/src/runtime.js';

test('both dispatcher callbacks surface delivery failure while webhook is acknowledged', async () => {
  let sends = 0;
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { sends++; res.end('{"status":"failed","retcode":100,"message":"denied"}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const withTyping of [false, true]) {
      const secret = 'fixture-secret';
      let recordedFailure;
      setNapCatConfig({ url: `http://127.0.0.1:${server.address().port}`, webhookSecret: secret, enableInboundLogging: false, enablePrivateTypingStatus: false, conversationConfigDir: '' });
      const reply = {
        dispatchReplyFromConfig: async ({ dispatcher }) => {
          try { await dispatcher.deliver({ text: 'reply' }); }
          catch (error) { recordedFailure = error; throw error; }
        },
      };
      if (withTyping) reply.createReplyDispatcherWithTyping = options => ({ dispatcher: options });
      else reply.createReplyDispatcher = options => options;
      setNapCatRuntime({ config: { current: () => ({}) }, channel: { reply, routing: { resolveAgentRoute: () => ({ agentId: 'main', accountId: 'default', sessionKey: 'fixture' }) } } });
      const raw = Buffer.from(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 12345, message_id: 1, message: 'hello' }));
      const req = Readable.from([raw]);
      Object.assign(req, { url: '/napcat', method: 'POST', headers: { 'x-signature': 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex') } });
      const res = { statusCode: 200, setHeader() {}, end() {} };
      await handleNapCatWebhook(req, res);
      assert.match(recordedFailure?.message ?? '', /returned failure/);
      assert.equal(res.statusCode, 200);
    }
    assert.equal(sends, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
