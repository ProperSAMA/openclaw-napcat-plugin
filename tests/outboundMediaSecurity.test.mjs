import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveNapCatMediaFileValue } from '../dist/src/media.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
test('outbound media rejects internal URLs instead of forwarding them', async () => {
  for (const url of ['http://127.0.0.1/private.png', 'http://169.254.169.254/metadata.png']) {
    await assert.rejects(resolveNapCatMediaFileValue(url, {}), /not allowed/);
  }
});
test('outbound local media enforces roots, symlinks, bytes and host restrictions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'napcat-outbound-'));
  const outside = await mkdtemp(join(tmpdir(), 'napcat-outside-'));
  try {
    await writeFile(join(root, 'safe.png'), png);
    await writeFile(join(outside, 'secret.txt'), 'not an image');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.png'));
    await writeFile(join(root, 'fake.png'), 'not an image');
    const cfg = { mediaProxyAllowedRoots: [root] };
    assert.equal(await resolveNapCatMediaFileValue(join(root, 'safe.png'), cfg), 'base64://' + png.toString('base64'));
    for (const file of ['escape.png', 'fake.png']) await assert.rejects(resolveNapCatMediaFileValue(join(root, file), cfg));
    await assert.rejects(resolveNapCatMediaFileValue(join(root, 'safe.png'), cfg, { mediaAccess: { localRoots: [] } }));
    let requested;
    assert.equal(await resolveNapCatMediaFileValue(join(root, 'safe.png'), {}, { mediaAccess: { readFile: async path => { requested = path; return png; } } }), 'base64://' + png.toString('base64'));
    assert.equal(requested, join(root, 'safe.png'));
    await assert.rejects(resolveNapCatMediaFileValue(join(root, 'safe.png'), cfg, { mediaAccess: { readFile: async () => { throw Error('host denied'); } } }), /host denied/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
