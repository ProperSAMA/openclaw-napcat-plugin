import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { napcatPlugin } from '../dist/src/channel.js';

test('concurrent same-name uploads use isolated copies and preserve a source inside staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'napcat-stage-'));
  const stage = join(root, 'stage');
  const other = join(root, 'other');
  await mkdir(stage); await mkdir(other);
  await writeFile(join(stage, 'report.txt'), 'first');
  await writeFile(join(other, 'report.txt'), 'second');
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    requests.push({ payload, res });
    if (requests.length === 2) {
      for (const request of requests) {
        request.content = await readFile(join(stage, request.payload.file.slice('/uploads/'.length)), 'utf8');
        request.res.end('{"status":"ok","retcode":0,"data":{"file_id":"fixture"}}');
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const cfg = { channels: { napcat: { url: `http://127.0.0.1:${server.address().port}`, conversationConfigDir: '', groupFileStageHostDir: stage, groupFileStageContainerDir: '/uploads' } } };
    await Promise.all([stage, other].map(dir => napcatPlugin.outbound.sendMedia({ to: 'group:12345', mediaUrl: join(dir, 'report.txt'), cfg })));
    assert.notEqual(requests[0].payload.file, requests[1].payload.file);
    assert.deepEqual(requests.map(r => r.content).sort(), ['first', 'second']);
    assert.equal(await readFile(join(stage, 'report.txt'), 'utf8'), 'first');
    assert.deepEqual(await readdir(stage), ['report.txt']);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
