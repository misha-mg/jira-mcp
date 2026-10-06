import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pack, type Header } from 'tar-stream';
import { Pax, Header as TarHeader } from 'tar';
import { prepareArchive } from '../src/archives.js';

type Item = Partial<Header> & { name: string; body?: Buffer | string };
export async function archive(items: Item[]) {
  const tar = pack(); const chunks: Buffer[] = [];
  const drain = (async () => { for await (const chunk of tar) chunks.push(chunk as Buffer); })();
  for (const { body = '', ...header } of items) {
    await new Promise<void>((resolve, reject) => tar.entry(header, body, error => error ? reject(error) : resolve()));
  }
  tar.finalize(); await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function fixture(action: (source: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'jira-tar-')); const directory = join(root, 'view'); await mkdir(directory);
  try { await action(join(root, 'source.tar.gz'), directory); } finally { await rm(root, { recursive: true, force: true }); }
}
const rows = async (directory: string) => (await readFile(join(directory, 'index.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

function ignoredTar(size: number) {
  const header = new TarHeader({ path: 'unsupported', type: 'SolarisACL', size, mode: 0o600, uid: 0, gid: 0, mtime: new Date(0) });
  header.encode();
  return Buffer.concat([header.block!, Buffer.alloc(size, 'x'), Buffer.alloc((512 - size % 512) % 512), Buffer.alloc(1024)]);
}

test('library-ignored entries are indexed as refusals and still validate their actual length', async () => {
  await fixture(async (source, directory) => {
    await writeFile(source, gzipSync(ignoredTar(100_000)));
    const result = await prepareArchive(source, directory, { remainingBytes: 200_000 }, 10);
    assert.equal(result.count, 1); assert.equal(result.skipped, 1);
    const [row] = await rows(directory); assert.equal(row.type, 'SolarisACL'); assert.equal(row.size, 100_000); assert.ok(row.skipped);
    assert.deepEqual(await readdir(join(directory, 'files')), []);
  });
  await fixture(async (source, directory) => {
    await writeFile(source, gzipSync(ignoredTar(100_000).subarray(0, 2000)));
    await assert.rejects(prepareArchive(source, directory, { remainingBytes: 200_000 }, 10), /damaged/);
  });
});

test('cancellation stops the library while draining an ignored entry', async () => fixture(async (source, directory) => {
  await writeFile(source, gzipSync(ignoredTar(1_000_000)));
  const controller = new AbortController(); let remaining = 2_000_000;
  const budget = { get remainingBytes() { return remaining; }, set remainingBytes(value: number) {
    remaining = value;
    // Abort after real decompression has begun, rather than before opening the file.
    if (remaining < 1_900_000) controller.abort();
  } };
  await assert.rejects(prepareArchive(source, directory, budget, 10, controller.signal), /cancelled/);
}));

test('archive preserves bytes, private modes, nested files, and text/binary/unknown hints without recursive processing', async () => fixture(async (source, directory) => {
  const input = await archive([{ name: './', type: 'directory' }, { name: './var/log', type: 'directory', mode: 0o777 },
    { name: './var/log/system.log', body: 'log é\n', mode: 0o777 }, { name: 'dump.cdb', body: Buffer.from([0, 1, 255]) },
    { name: 'empty', body: '' }, { name: 'nested.har', body: '{"log":{"entries":[]}}' }]);
  await writeFile(source, input);
  const result = await prepareArchive(source, directory, { remainingBytes: 100_000 }, 20);
  assert.equal(result.count, 6); assert.equal(result.skipped, 0);
  const index = await rows(directory);
  assert.equal(index[2].classification, 'text'); assert.equal(index[3].classification, 'binary'); assert.equal(index[4].classification, 'unknown');
  assert.equal(await readFile(join(directory, index[2].extractedPath), 'utf8'), 'log é\n');
  assert.deepEqual(await readFile(join(directory, index[3].extractedPath)), Buffer.from([0, 1, 255]));
  assert.equal((await stat(join(directory, index[2].extractedPath))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'files/var/log'))).mode & 0o777, 0o700);
  assert.ok(!(await readdir(join(directory, 'files'))).some(name => name.endsWith('.har.har')));
}));

test('archive refuses traversal, absolute and Windows paths, links, special files, duplicates and file/directory conflicts', async () => fixture(async (source, directory) => {
  const entries: Item[] = [
    { name: '../escape', body: 'bad' }, { name: '/absolute', body: 'bad' }, { name: 'C:/absolute', body: 'bad' },
    { name: 'safe/../../escape', body: 'bad' }, { name: 'a\\..\\bad', body: 'bad' },
    { name: 'sym', type: 'symlink', linkname: '../escape' }, { name: 'hard', type: 'link', linkname: 'data' },
    { name: 'pipe', type: 'fifo' }, { name: 'device', type: 'block-device' },
    { name: 'data', body: 'first' }, { name: './data', body: 'second' }, { name: 'data/child', body: 'bad' },
    { name: 'dir', type: 'directory' }, { name: 'dir', body: 'bad' },
    { name: 'pax-safe', body: 'bad', pax: { path: '../pax-escape' } },
  ];
  await writeFile(source, await archive(entries));
  const result = await prepareArchive(source, directory, { remainingBytes: 100_000 }, 50);
  assert.equal(result.skipped, entries.length - 2);
  const index = await rows(directory);
  assert.equal(await readFile(join(directory, 'files/data'), 'utf8'), 'first');
  assert.deepEqual((await readdir(join(directory, 'files'))).sort(), ['data', 'dir']);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 13, 14]) { assert.ok(index[i].skipped); assert.equal(index[i].extractedPath, undefined); }
  assert.equal(index[14].path, '../pax-escape');
}));

test('archive accepts library-resolved PAX long paths and refuses effective traversal names', async () => fixture(async (source, directory) => {
  const name = `${'directory/'.repeat(18)}config.xml`;
  await writeFile(source, await archive([{ name, body: '<config/>' }]));
  await prepareArchive(source, directory, { remainingBytes: 100_000 }, 10);
  const [row] = await rows(directory); assert.equal(row.path, name);
  assert.equal(await readFile(join(directory, row.extractedPath), 'utf8'), '<config/>');
}));

test('archive enforces actual expanded bytes including skipped entries/metadata, entry count, and rejects corruption', async () => {
  const inputs = [
    { buffer: await archive([{ name: '../skip', body: 'a'.repeat(100_000) }]), bytes: 10_000, entries: 10 },
    { buffer: await archive([{ name: 'one' }, { name: 'two' }]), bytes: 100_000, entries: 1 },
    { buffer: Buffer.from('not gzip'), bytes: 100_000, entries: 10 },
    { buffer: (await archive([{ name: 'one', body: 'first' }])).subarray(0, 30), bytes: 100_000, entries: 10 },
    { buffer: gzipSync(Buffer.alloc(511, 1)), bytes: 100_000, entries: 10 },
    { buffer: gzipSync(gunzipSync(await archive([{ name: 'truncated', body: 'x'.repeat(2000) }])).subarray(0, 800)), bytes: 100_000, entries: 10 },
    { buffer: await archive([{ name: 'meta', body: '', pax: { comment: 'x'.repeat(1024 * 1024 + 1) } }]), bytes: 2_000_000, entries: 10 },
  ];
  for (const { buffer, bytes, entries } of inputs) await fixture(async (source, directory) => {
    await writeFile(source, buffer);
    await assert.rejects(prepareArchive(source, directory, { remainingBytes: bytes }, entries));
  });
});

test('empty archive produces an empty index without inventing entries', async () => fixture(async (source, directory) => {
  await writeFile(source, await archive([]));
  const result = await prepareArchive(source, directory, { remainingBytes: 100_000 }, 10);
  assert.equal(result.count, 0); assert.equal(result.skipped, 0);
  assert.equal(await readFile(join(directory, 'index.jsonl'), 'utf8'), '');
}));

test('nested compression cannot bypass the actual expanded byte budget', async () => fixture(async (source, directory) => {
  await writeFile(source, gzipSync(await archive([{ name: 'large', body: 'x'.repeat(100_000) }])));
  await assert.rejects(prepareArchive(source, directory, { remainingBytes: 10_000 }, 10), /Nested archive compression/);
  assert.deepEqual(await readdir(join(directory, 'files')), []);
}));

test('trailing TAR padding still counts toward the actual expanded budget', async () => {
  for (const budget of [100_000, 10_000]) await fixture(async (source, directory) => {
    const tar = gunzipSync(await archive([{ name: 'data', body: 'first' }]));
    await writeFile(source, gzipSync(Buffer.concat([tar, Buffer.alloc(64_000)])));
    const operation = prepareArchive(source, directory, { remainingBytes: budget }, 10);
    if (budget < 64_000) await assert.rejects(operation, /expanded byte limit/);
    else {
      const result = await operation; assert.equal(result.bytes, tar.length + 64_000); assert.equal(result.count, 1);
      assert.equal(await readFile(join(directory, 'files/data'), 'utf8'), 'first');
    }
  });
});


test('global PAX paths and sparse metadata are explicitly refused before accepting ordinary headers', async () => {
  const cases = [
    { path: '../escape' }, { path: '/absolute' }, { path: 'safe-alias' }, { uid: 1000 },
  ];
  for (const attributes of cases) await fixture(async (source, directory) => {
    // Both libraries generate their own metadata/header records; no handwritten TAR decoder.
    await writeFile(source, gzipSync(Buffer.concat([new Pax(attributes, true).encode(),
      gunzipSync(await archive([{ name: 'nominal', body: 'abc' }]))])));
    await assert.rejects(prepareArchive(source, directory, { remainingBytes: 100_000 }, 10), /Global PAX|Sparse archive/);
    assert.deepEqual(await readdir(join(directory, 'files')), []);
  });
  await fixture(async (source, directory) => {
    await writeFile(source, await archive([{ name: 'sparse', body: 'abc', pax: { 'GNU.sparse.map': '0,3' } }]));
    await assert.rejects(prepareArchive(source, directory, { remainingBytes: 100_000 }, 10), /Sparse archive/);
    assert.deepEqual(await readdir(join(directory, 'files')), []);
  });
});
