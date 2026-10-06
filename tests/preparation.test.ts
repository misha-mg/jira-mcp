import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { Pax } from 'tar';
import { AttachmentStore } from '../src/attachments.js';
import { config, mockClient } from './helpers.js';
import { tokens } from '../src/output.js';

async function archive() {
  const stream = pack(); const chunks: Buffer[] = [];
  const reading = (async () => { for await (const chunk of stream) chunks.push(chunk as Buffer); })();
  stream.entry({ name: 'log.txt' }, 'log contents'); stream.finalize(); await reading;
  return gzipSync(Buffer.concat(chunks));
}
const first = (value: string) => JSON.parse(value.split('\n')[0]!);
async function fixture(action: (store: AttachmentStore, folder: string) => Promise<void>, overrides = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'jira-preparation-'));
  try { await action(new AttachmentStore({ ...config, attachmentDir: folder, ...overrides }), folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test('HAR and TAR.GZ integrate with stable completed caches; incomplete cache regenerates', async () => {
  for (const name of ['network.har', 'logs.tar.gz', 'logs.tgz']) {
    await fixture(async (store) => {
      const data = name.endsWith('.har') ? Buffer.from('{"log":{"entries":[{"request":{"method":"GET"},"response":{"status":204}}]}}') : await archive();
      const file = { id: '101', filename: name, mimeType: 'application/octet-stream', size: data.length };
      let calls = 0; const client = mockClient(() => { calls++; return new Response(new Uint8Array(data)); });
      const row = first(await store.download(client, 'DEMO-1', [file]));
      assert.equal(row.preparation.count, 1); assert.ok(row.path); assert.ok(row.preparation.index);
      const reused = first(await store.download(client, 'DEMO-1', [file]));
      assert.equal(reused.reused, true); assert.equal(reused.preparation.reused, true); assert.equal(calls, 1);
      const marker = join(row.preparation.directory, '.complete.json');
      await rm(marker);
      await writeFile(join(row.preparation.directory, 'partial'), 'incomplete');
      const rebuilt = first(await store.download(client, 'DEMO-1', [file]));
      assert.equal(rebuilt.preparation.reused, undefined); assert.equal(calls, 1);
      assert.ok(!(await readdir(row.preparation.directory)).includes('partial'));
      await rm(row.preparation.index);
      assert.ok(first(await store.download(client, 'DEMO-1', [file])).preparation.index);
      await writeFile(marker, JSON.stringify({ id: file.id, size: file.size + 1, count: 1 }));
      assert.equal(first(await store.download(client, 'DEMO-1', [file])).preparation.reused, undefined);
    });
  }
});

test('preparation failures retain originals and remove partial directories; ordinary formats remain untouched', async () => fixture(async store => {
  for (const filename of ['broken.har', 'broken.tar.gz']) {
    const file = { id: '1', filename, mimeType: 'application/octet-stream', size: 3 };
    const row = first(await store.download(mockClient(() => new Response('bad')), 'DEMO-1', [file]));
    assert.ok(row.path); assert.ok(row.preparation.skipped); assert.equal(await readFile(row.path, 'utf8'), 'bad');
    await assert.rejects(readFile(join(`${row.path}.${filename.endsWith('.har') ? 'har' : 'extracted'}`, 'index.jsonl')), { code: 'ENOENT' });
  }
  for (const filename of ['plain.json', 'text.log', 'image.gif', 'traffic.pcap', 'database.cdb']) {
    const row = first(await store.download(mockClient(() => new Response('raw')), 'DEMO-1', [{ id: '2', filename, mimeType: 'application/octet-stream', size: 3 }]));
    assert.ok(row.path); assert.equal(row.preparation, undefined); assert.equal(await readFile(row.path, 'utf8'), 'raw');
  }
}));

test('archive budget is shared across preparations and caches and failures clean their output', async () => fixture(async store => {
  const data = await archive();
  const files = [1, 2].map(id => ({ id: String(id), filename: 'log.tar.gz', mimeType: 'application/gzip', size: data.length }));
  const client = mockClient(() => new Response(new Uint8Array(data)));
  for (let i = 0; i < 2; i++) {
    const rows = (await store.download(client, 'DEMO-1', files)).split('\n').map(line => JSON.parse(line));
    assert.ok(rows[0].preparation.directory); assert.match(rows[1].preparation.skipped, /expanded byte/);
    assert.equal(await readFile(rows[1].path).then(buffer => buffer.length), data.length);
    await assert.rejects(readFile(`${rows[1].path}.extracted/index.jsonl`), { code: 'ENOENT' });
  }
}, { maxExtractedBytes: 2300 }));

test('unsupported global PAX and sparse metadata retain originals and remove all partial output', async () => fixture(async store => {
  const data = await archive();
  const sparse = pack(); const chunks: Buffer[] = [];
  const reading = (async () => { for await (const chunk of sparse) chunks.push(chunk as Buffer); })();
  sparse.entry({ name: 'sparse', pax: { 'GNU.sparse.map': '0,3' } }, 'abc'); sparse.finalize(); await reading;
  const inputs = [gzipSync(Buffer.concat([new Pax({ path: '../escape' }, true).encode(), gunzipSync(data)])), gzipSync(Buffer.concat(chunks))];
  for (const [i, input] of inputs.entries()) {
    const row = first(await store.download(mockClient(() => new Response(new Uint8Array(input))), 'DEMO-1',
      [{ id: String(i + 1), filename: 'unsupported.tar.gz', mimeType: 'application/gzip', size: input.length }]));
    assert.match(row.preparation.skipped, /Global PAX|Sparse archive/);
    assert.deepEqual(await readFile(row.path), input);
    await assert.rejects(readdir(row.path + '.extracted'), { code: 'ENOENT' });
  }
}));

test('symlink preparation directories and markers are refused without touching their targets', async () => fixture(async (store, folder) => {
  const issueFolder = join(folder, config.sessionId, 'DEMO-1'); await mkdir(issueFolder, { recursive: true });
  const source = join(issueFolder, '1-network.har'); const text = '{"log":{"entries":[]}}'; await writeFile(source, text);
  const outside = join(folder, 'outside'); await mkdir(outside); await writeFile(join(outside, 'safe'), 'keep');
  const derived = source + '.har'; await symlink(outside, derived);
  const file = { id: '1', filename: 'network.har', mimeType: 'application/json', size: Buffer.byteLength(text) };
  const client = mockClient(() => { throw new Error('should reuse original'); });
  assert.match(first(await store.download(client, 'DEMO-1', [file])).preparation.skipped, /Unsafe/);
  assert.equal(await readFile(join(outside, 'safe'), 'utf8'), 'keep');
  await rm(derived); await mkdir(derived); await symlink(join(outside, 'safe'), join(derived, '.complete.json'));
  assert.match(first(await store.download(client, 'DEMO-1', [file])).preparation.skipped, /Unsafe/);
  assert.equal(await readFile(join(outside, 'safe'), 'utf8'), 'keep');
}));

test('prepared attachment output stays within the reference token budget before doing work', async () => fixture(async store => {
  const text = '{"log":{"entries":[]}}'; let downloads = 0;
  const files = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), filename: `network-${'long'.repeat(20)}.har`, mimeType: 'application/json', size: Buffer.byteLength(text) }));
  const result = await store.download(mockClient(() => { downloads++; return new Response(text); }), 'DEMO-1', files);
  assert.ok(tokens(result) <= 4000); assert.ok(downloads < files.length); assert.match(result, /Output limit reached/);
}));

test('caller cancellation stops HAR preparation, removes its partial folder and retains the original', async () => fixture(async (store, folder) => {
  const issueFolder = join(folder, config.sessionId, 'DEMO-1'); await mkdir(issueFolder, { recursive: true });
  const text = '{"log":{"entries":[{"_initiator":{"large":"' + 'x'.repeat(8_000_000) + '"},"response":{"content":{"text":"{}"}}}]}}';
  const source = join(issueFolder, '1-cancel.har'); await writeFile(source, text);
  const file = { id: '1', filename: 'cancel.har', mimeType: 'application/json', size: Buffer.byteLength(text) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(store.download(mockClient(() => { throw new Error('should reuse'); }), 'DEMO-1', [file], controller.signal)); }
  finally { clearTimeout(timer); }
  assert.equal((await readFile(source)).length, file.size);
  await assert.rejects(readdir(source + '.har'), { code: 'ENOENT' });
}));

test('caller cancellation removes partial TAR.GZ extraction while preserving the archive', async () => fixture(async (store, folder) => {
  const issueFolder = join(folder, config.sessionId, 'DEMO-1'); await mkdir(issueFolder, { recursive: true });
  const tar = pack(); const chunks: Buffer[] = [];
  const drain = (async () => { for await (const chunk of tar) chunks.push(chunk as Buffer); })();
  tar.entry({ name: 'large.log' }, Buffer.alloc(16_000_000, 'x')); tar.finalize(); await drain;
  const data = gzipSync(Buffer.concat(chunks)); const source = join(issueFolder, '1-cancel.tar.gz'); await writeFile(source, data);
  const file = { id: '1', filename: 'cancel.tar.gz', mimeType: 'application/gzip', size: data.length };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(store.download(mockClient(() => { throw new Error('should reuse'); }), 'DEMO-1', [file], controller.signal)); }
  finally { clearTimeout(timer); }
  assert.deepEqual(await readFile(source), data);
  await assert.rejects(readdir(source + '.extracted'), { code: 'ENOENT' });
}));
