import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentStore } from '../src/attachments.js';
import { getAttachments } from '../src/tools/get-attachments.js';
import { config, issue, json, mockClient } from './helpers.js';
import type { Config } from '../src/config.js';

async function withStore(action: (store: AttachmentStore, conf: Config) => Promise<void>, overrides: Partial<Config> = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'jira-files-'));
  const conf = { ...config, ...overrides, attachmentDir: join(folder, 'attachments') };
  try { await action(new AttachmentStore(conf), conf); }
  finally { await rm(folder, { recursive: true, force: true }); }
}
const file = { id: '101', filename: 'screen.png', mimeType: 'image/png', size: 4 };
test('downloads real bytes to stable paths; concurrent/repeated calls reuse files', async () => withStore(async (store, conf) => {
  let requests = 0;
  const client = mockClient(() => { requests++; return new Response('data'); });
  const [a, b] = await Promise.all([store.download(client, 'DEMO-8901', [file]), store.download(client, 'DEMO-8901', [file])]);
  const one = JSON.parse(a.split('\n')[0]!); const two = JSON.parse(b.split('\n')[0]!);
  assert.equal(one.path, two.path);
  assert.equal(await readFile(one.path, 'utf8'), 'data');
  assert.equal(two.reused, true);
  assert.equal(requests, 1);
  assert.ok(one.path.includes(join(conf.sessionId, 'DEMO-8901')));
  assert.doesNotMatch(a, /base64|ZGF0YQ==/);
}));
test('traversal and colliding filenames stay confined; symlink destination is refused', async () => withStore(async (store, conf) => {
  const files = ['../../etc/passwd', '/tmp/absolute', 'x\\y', 'same.png', 'same.png'].map((filename, i) => ({ ...file, id: String(i + 1), filename }));
  const client = mockClient(() => new Response('data'));
  const output = await store.download(client, 'DEMO-8901', files);
  const rows = output.split('\n').slice(0, -1).map(line => JSON.parse(line));
  assert.equal(new Set(rows.map(row => row.path)).size, 5);
  for (const row of rows) { assert.ok(row.path.startsWith(await realpath(conf.attachmentDir) + '/')); assert.equal(await readFile(row.path, 'utf8'), 'data'); }
  const outside = join(conf.attachmentDir, '..', 'untouched');
  await writeFile(outside, 'safe');
  await symlink(outside, join(conf.attachmentDir, conf.sessionId, 'DEMO-8901', '101-screen.png'));
  assert.match(await store.download(client, 'DEMO-8901', [file]), /not a regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'safe');
}));
test('symlink session directory cannot escape root', async () => withStore(async (store, conf) => {
  await store.prepare();
  const outside = join(conf.attachmentDir, '..', 'outside');
  await mkdir(outside);
  await symlink(outside, join(conf.attachmentDir, conf.sessionId));
  await assert.rejects(store.download(mockClient(() => new Response('data')), 'DEMO-8901', [file]), /symlink/);
  assert.deepEqual(await readdir(outside), []);
}));
test('oversize metadata is skipped; actual streamed bytes enforce limits and remove partials', async () => withStore(async (store, conf) => {
  let requests = 0;
  const client = mockClient(() => { requests++; return new Response('too much data'); });
  assert.match(await store.download(client, 'DEMO-8901', [{ ...file, size: 6 }]), /size exceeds/);
  assert.equal(requests, 0);
  assert.match(await store.download(client, 'DEMO-8901', [file]), /exceeded/);
  assert.deepEqual(await readdir(join(conf.attachmentDir, conf.sessionId, 'DEMO-8901')), []);
}, { maxFileBytes: 5, maxCallBytes: 6 }));
test('interrupted response discards partial file', async () => withStore(async (store, conf) => {
  let reads = 0;
  const client = mockClient(() => new Response(new ReadableStream({ pull(controller) {
    if (reads++) controller.error(new Error('network failure')); else controller.enqueue(new TextEncoder().encode('da'));
  } })));
  assert.match(await store.download(client, 'DEMO-8901', [file]), /discarded/);
  assert.deepEqual(await readdir(join(conf.attachmentDir, conf.sessionId, 'DEMO-8901')), []);
}));
test('call total limit covers multiple files', async () => withStore(async (store) => {
  let requests = 0;
  const client = mockClient(() => { requests++; return new Response('data'); });
  const output = await store.download(client, 'DEMO-8901', [file, { ...file, id: '102' }]);
  assert.equal(requests, 1); assert.match(output, /remaining call limit/);
}, { maxCallBytes: 6 }));
test('IDs from other issues fail before any download', async () => withStore(async store => {
  const client = mockClient(url => { assert.ok(url.pathname.endsWith('/issue/DEMO-8901')); return json(issue); });
  await assert.rejects(getAttachments(client, store, { key: 'DEMO-8901', ids: ['999'] }), /do not belong/);
}));
