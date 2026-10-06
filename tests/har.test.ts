import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHar } from '../src/har.js';

export const harEntry = (request = '{"jsonrpc":"2.0","id":1,"method":"get_values","params":{"path":"/first","th":3,"method":"read"}}',
  response = '{"jsonrpc":"2.0","id":1,"result":{}}', encoding?: string) => ({
  startedDateTime: '2026-10-06T00:00:00Z', time: 42,
  request: { method: 'POST', url: 'https://user:pass@example.com/jsonrpc/get_values?token=private', postData: { text: request } },
  response: { status: 200, content: { text: response, ...(encoding ? { encoding } : {}) } },
});
async function fixture(action: (source: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'jira-har-'));
  const directory = join(root, 'view'); await mkdir(directory);
  try { await action(join(root, 'source.har'), directory); } finally { await rm(root, { recursive: true, force: true }); }
}
const index = async (directory: string) => (await readFile(join(directory, 'index.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('HAR index identifies RPC parameters, HTTP-200 errors, truncation, ordered bodies, and no query values', async () => fixture(async (source, directory) => {
  const entries = [harEntry(), harEntry('{"method":"get_values","params":{"path":"/second","th":7,"method":"edit"}}',
    JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'ConfD error', data: { reason: 'Invalid path', detail: 'x'.repeat(3000) } } })),
  harEntry('not JSON', '{"id":3,"result":"😀 é"}')];
  await writeFile(source, JSON.stringify({ log: { entries } }));
  assert.deepEqual(await prepareHar(source, directory), { count: 3 });
  const rows = await index(directory);
  assert.equal(rows[0].entry, 1); assert.equal(rows[0].status, 200); assert.equal(rows[0].timeMs, 42);
  assert.equal(rows[0].url, 'https://example.com/jsonrpc/get_values');
  assert.equal(rows[0].rpcMethod, 'get_values'); assert.equal(rows[0].path, '/first');
  assert.equal(rows[0].th, 3); assert.equal(rows[0]['params.method'], 'read'); assert.equal(rows[0].error, false);
  assert.equal(rows[1].path, '/second'); assert.equal(rows[1].error, true);
  assert.match(rows[1].errorText, /ConfD error.*Invalid path/); assert.ok(rows[1].errorText.length <= 1024);
  assert.ok(rows[1].truncatedFields.includes('errorText'));
  assert.equal(rows[2].rpcMethod, 'get_values'); assert.equal(rows[2].error, false);
  assert.equal(rows[2].responseBytes, Buffer.byteLength(entries[2]!.response.content.text));
  assert.equal(rows[0].requestBody, 'entries/0001.request.txt');
  assert.equal((await stat(join(directory, rows[0].requestBody))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(rows), /private|user:pass/);
}));

test('HAR checks all batch elements and never presents missing, encoded, invalid or unrelated responses as success', async () => fixture(async (source, directory) => {
  const bodies = ['[{"id":1,"result":0},{"id":2,"error":{"message":"batch failure"}}]',
    '[{"id":1,"result":0},{"unrelated":true}]', '[{"id":1,"result":0},[]]',
    '{"status":"ok"}', '{"jsonrpc":"2.0","result":1}', '{"id":1,"result":', '[]'];
  const entries: object[] = bodies.map(body => harEntry(undefined, body));
  entries.push(harEntry(undefined, Buffer.from('{"id":1,"error":{"message":"encoded"}}').toString('base64'), 'base64'));
  entries.push({ request: { method: 'GET', url: 'https://example.com/test' }, response: { status: 204, content: {} } });
  await writeFile(source, JSON.stringify({ log: { entries } }));
  await prepareHar(source, directory);
  const rows = await index(directory);
  assert.equal(rows[0].error, true); assert.equal(rows[0].errorText, 'batch failure');
  for (const row of rows.slice(1)) { assert.equal(row.error, null); assert.ok(row.errorReason); }
  assert.match(rows[7].errorReason, /Encoded/); assert.equal(rows[7].responseEncoding, 'base64');
  assert.equal(rows[8].responseBody, undefined);
}));

test('HAR skips large extra fields, preserves decoded Unicode sizes and makes long get_schema strings readable by line', async () => fixture(async (source, directory) => {
  const text = JSON.stringify({ id: 1, result: { schema: '😀'.repeat(50_000) } });
  const entry = { ...harEntry('{"method":"get_schema"}', text), _initiator: { stack: { ignored: 'a'.repeat(300_000) } }, extra: 'b'.repeat(100_000) };
  await writeFile(source, JSON.stringify({ log: { entries: [entry] } }));
  await prepareHar(source, directory);
  const [row] = await index(directory);
  assert.equal(row.responseBytes, Buffer.byteLength(text));
  assert.equal(row.responseView.lineWrapped, true); assert.equal(row.responseView.formatted, true);
  assert.equal(row.responseView.representation, 'readable-text-view');
  const body = await readFile(join(directory, row.responseBody), 'utf8');
  assert.ok(body.split('\n').every(line => line.length <= 2001));
  assert.equal(body.replaceAll('\n', ''), text); assert.doesNotMatch(body, /�/);
  assert.doesNotMatch(await readFile(join(directory, 'index.jsonl'), 'utf8'), /ignored|initiator|extra/);
}));

test('invalid HAR structure, duplicates, and truncated outer JSON reject preparation', async () => {
  for (const content of ['{}', '{"log":{"entries":[1]}}', '{"log":{"entries":{}}}', '{"log":{"entries":[{}]',
    '{"log":{"entries":[{"request":{"postData":{"text":"a","text":"b"}}}]}}']) {
    await fixture(async (source, directory) => { await writeFile(source, content); await assert.rejects(prepareHar(source, directory)); });
  }
});

test('literal dotted keys and inherited property names cannot masquerade as HAR/RPC fields', async () => fixture(async (source, directory) => {
  const entry = { ...harEntry('{"method":"real","params.method":"fake","params":{"method":"nested"}}', '{"id":1,"result":{},"error.message":"fake error text"}'),
    'response.status': 500, constructor: 'ignored', toString: 'ignored' };
  await writeFile(source, JSON.stringify({ log: { entries: [entry] } }));
  await prepareHar(source, directory);
  const [row] = await index(directory);
  assert.equal(row.status, 200); assert.equal(row.rpcMethod, 'real'); assert.equal(row['params.method'], 'nested');
  assert.equal(row.error, false); assert.equal(row.errorText, undefined); assert.doesNotMatch(JSON.stringify(row), /ignored|fake/);
}));

test('malformed RPC IDs/versions remain unknown, including batch elements; scalar IDs and legacy ConfD still work', async () => fixture(async (source, directory) => {
  const invalid = [
    '{"id":{},"result":0}', '{"id":[],"result":0}', '{"id":true,"result":0}', '{"id":1e999,"result":0}',
    '{"jsonrpc":"wrong","id":1,"result":0}', '{"jsonrpc":null,"id":1,"result":0}', '{"jsonrpc":{},"id":1,"result":0}',
    '{"jsonrpc":2.0,"id":1,"result":0}',
    '[{"id":1,"result":0},{"id":{},"result":0}]',
  ];
  const valid = ['{"id":1,"result":0}', '{"id":"legacy","result":0}', '{"jsonrpc":"2.0","id":null,"result":0}'];
  const partialError = '[{"id":{},"result":0},{"id":1,"error":{"message":"known failure"}}]';
  await writeFile(source, JSON.stringify({ log: { entries: [...invalid, ...valid, partialError].map(body => harEntry(undefined, body)) } }));
  await prepareHar(source, directory);
  const result = await index(directory);
  for (const row of result.slice(0, invalid.length)) { assert.equal(row.error, null); assert.ok(row.errorReason); }
  for (const row of result.slice(invalid.length, -1)) { assert.equal(row.error, false); assert.equal(row.errorReason, undefined); }
  assert.equal(result.at(-1).error, true); assert.ok(result.at(-1).errorReason);
}));

test('error-text preview marks discarded values at the exact limit without falsely marking a complete message', async () => fixture(async (source, directory) => {
  const response = (message: string, data?: unknown) => JSON.stringify({ id: 1, error: { message, ...(data === undefined ? {} : { data }) } });
  const bodies = [response('x'.repeat(1024), { detail: 'omitted' }), response('x'.repeat(1024)), response('x'.repeat(1023), { detail: 'omitted' }),
    response('short', { first: 'y'.repeat(1100), second: 'omitted' })];
  await writeFile(source, JSON.stringify({ log: { entries: bodies.map(body => harEntry(undefined, body)) } }));
  await prepareHar(source, directory);
  const result = await index(directory);
  for (const i of [0, 2, 3]) { assert.equal(result[i].error, true); assert.equal(result[i].errorText.length, 1024); assert.ok(result[i].truncatedFields.includes('errorText')); }
  assert.equal(result[1].errorText.length, 1024); assert.equal(result[1].truncatedFields, undefined);
}));
