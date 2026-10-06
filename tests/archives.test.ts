import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack, type Header } from 'tar-stream';
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
    { name: 'sparse', body: 'bad', pax: { 'GNU.sparse.map': '0,3' } },
  ];
  await writeFile(source, await archive(entries));
  const result = await prepareArchive(source, directory, { remainingBytes: 100_000 }, 50);
  assert.equal(result.skipped, entries.length - 2);
  const index = await rows(directory);
  assert.equal(await readFile(join(directory, 'files/data'), 'utf8'), 'first');
  assert.deepEqual((await readdir(join(directory, 'files'))).sort(), ['data', 'dir']);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 13, 14, 15]) { assert.ok(index[i].skipped); assert.equal(index[i].extractedPath, undefined); }
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
  ];
  for (const { buffer, bytes, entries } of inputs) await fixture(async (source, directory) => {
    await writeFile(source, buffer);
    await assert.rejects(prepareArchive(source, directory, { remainingBytes: bytes }, entries));
  });
});
