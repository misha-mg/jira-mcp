import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Synthetic loopback HTTP + production store/processors over MCP stdio. Not a Claude Code test.
const folder = await mkdtemp(join(tmpdir(), 'jira-large-sdk-'));
const metrics = join(folder, 'metrics.json');
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['--max-old-space-size=128', '--import', 'tsx', resolve('tests/large-attachment-fixture.ts')],
  env: { TEST_FILE_BYTES: process.env.TEST_FILE_BYTES ?? '429000000', TEST_DELAY_MS: process.env.TEST_DELAY_MS ?? '0',
    TEST_CACHE_DIR: folder, TEST_METRICS_PATH: metrics }, stderr: 'pipe' });
const client = new Client({ name: 'large-attachment-check', version: '1' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'get_attachments', arguments: { key: 'SYNTH-1', ids: ['1'] } }, { timeout: 900_000 });
  assert.ok(!result.isError);
  const text = result.content.find((part: { type: string }) => part.type === 'text') as { text: string };
  const row = JSON.parse(text.text.split('\n')[0]!);
  assert.ok(row.path, row.skipped); assert.equal(row.preparation.count, 1);
  assert.equal((await stat(row.path)).size, Number(process.env.TEST_FILE_BYTES ?? '429000000'));
  const index = JSON.parse((await readFile(row.preparation.index, 'utf8')).trim());
  assert.equal(index.error, false); assert.equal(index.rpcMethod, 'get_schema'); assert.equal(index.path, '/synthetic');
  assert.ok(index.responseView.lineWrapped);
  const measurement = JSON.parse(await readFile(metrics, 'utf8'));
  const reused = await client.callTool({ name: 'get_attachments', arguments: { key: 'SYNTH-1', ids: ['1'] } });
  assert.match(JSON.stringify(reused.content), /reused/);
  console.log(JSON.stringify({ client: 'MCP SDK (not Claude Code)', ...measurement, verified: true }));
} finally { await client.close(); await rm(folder, { recursive: true, force: true }); }
