import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Opt-in real Claude Code CLI test with synthetic data only; uses the user's Claude authentication.
// No timeout overrides: records whether the installed client's default settings wait for the call.
const folder = await mkdtemp(join(tmpdir(), 'jira-large-claude-'));
const metrics = join(folder, 'metrics.json');
const configuration = join(folder, 'mcp.json');
await writeFile(configuration, JSON.stringify({ mcpServers: { large: { type: 'stdio', command: process.execPath,
  args: ['--max-old-space-size=128', '--import', 'tsx', resolve('tests/large-attachment-fixture.ts')],
  env: { TEST_CACHE_DIR: folder, TEST_METRICS_PATH: metrics, TEST_FILE_BYTES: process.env.TEST_FILE_BYTES ?? '429000000',
    TEST_DELAY_MS: process.env.TEST_DELAY_MS ?? '16' } } } }), { mode: 0o600 });
const child = spawn('claude', ['-p', '--strict-mcp-config', '--mcp-config', configuration, '--setting-sources', '',
  '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence', '--tools', 'Read',
  '--allowedTools', 'mcp__large__get_attachments', 'Read', '--add-dir', folder,
  '--output-format', 'stream-json', '--verbose', '--system-prompt', 'You are a client verification runner. Use only the instructed MCP tool and Read. Do not delegate, execute commands, or change any files.',
  'Call mcp__large__get_attachments exactly once with key SYNTH-1 and ids ["1"]. Wait for completion even if slow. Read the returned preparation.index with limit 1, then Read the responseBody file named by that index, relative to preparation.directory, using offset 10 and limit 3. After both reads return, say VERIFIED. If any tool fails, say FAILED and the reason.'],
  { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const events: Array<Record<string, any>> = [];
let pending = '', stderr = '';
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON CLI diagnostics */ }
  }
});
child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
const timeout = setTimeout(() => child.kill('SIGTERM'), 900_000);
try {
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const calls = events.flatMap(event => event.type === 'assistant' ? event.message?.content ?? [] : []).filter(part => part.type === 'tool_use');
  const results = events.flatMap(event => event.type === 'user' ? event.message?.content ?? [] : []).filter(part => part.type === 'tool_result');
  const init = events.find(event => event.type === 'system' && event.subtype === 'init');
  const final = events.findLast(event => event.type === 'result');
  let measurement: unknown;
  try { measurement = JSON.parse(await readFile(metrics, 'utf8')); } catch { /* failed before completion */ }
  console.log(JSON.stringify({ client: 'Claude Code CLI', code, connected: init?.mcp_servers?.some((s: { name: string; status: string }) => s.name === 'large' && s.status === 'connected'),
    toolCalls: calls.map(part => part.name), readRanges: calls.filter(part => part.name === 'Read').map(part => ({ offset: part.input?.offset, limit: part.input?.limit })), toolFailures: results.filter(part => part.is_error).length,
    measurement, verified: code === 0 && final?.result?.includes('VERIFIED') && calls.filter(part => part.name === 'Read').length >= 2,
    ...(code !== 0 || final?.is_error ? { failure: final?.result ?? (stderr.includes('login') ? 'Claude authentication unavailable.' : 'Claude run failed; inspect locally.') } : {}) }));
  assert.equal(code, 0); assert.equal(results.filter(part => part.is_error).length, 0);
  assert.equal(calls.filter(part => part.name === 'mcp__large__get_attachments').length, 1);
  const reads = calls.filter(part => part.name === 'Read');
  assert.ok(reads.some(part => part.input?.limit === 1));
  assert.ok(reads.some(part => part.input?.offset === 10 && part.input?.limit === 3)); assert.match(final?.result ?? '', /VERIFIED/);
} finally { clearTimeout(timeout); await rm(folder, { recursive: true, force: true }); }
