import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { readWebhookBody } from '../dist/src/webhookBody.js';
function request(headers = {}) { const req = new PassThrough(); req.headers = headers; return req; }
test('body limits reject declared and streamed oversized bodies', async () => {
  await assert.rejects(readWebhookBody(request({ 'content-length': '100' }), { maxBytes: 10 }), { statusCode: 413 });
  const req = request();
  const result = readWebhookBody(req, { maxBytes: 10 });
  req.write(Buffer.alloc(6)); req.write(Buffer.alloc(6));
  await assert.rejects(result, { statusCode: 413 });
  assert.equal(req.listenerCount('data'), 0);
});
test('slow and interrupted bodies terminate instead of hanging', async () => {
  await assert.rejects(readWebhookBody(request(), { timeoutMs: 20 }), { statusCode: 408 });
  const req = request();
  const result = readWebhookBody(req);
  req.emit('aborted');
  await assert.rejects(result, { statusCode: 400 });
});
test('body preserves raw UTF-8 bytes split across chunks for signature verification', async () => {
  const req = request();
  const raw = Buffer.from('你好');
  const result = readWebhookBody(req, { maxBytes: raw.length });
  req.write(raw.subarray(0, 1)); req.end(raw.subarray(1));
  assert.deepEqual(await result, raw);
});
