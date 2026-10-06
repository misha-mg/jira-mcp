import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeAttachment, validateClaudeLarge } from './claude-large-validation.js';

// Opt-in real Claude Code CLI test with synthetic data only; uses the user's Claude authentication.
// No timeout overrides: records whether the installed client's default settings wait for the call.
const folder = await mkdtemp(join(tmpdir(), 'jira-large-claude-'));
const metrics = join(folder, 'metrics.json');
const configuration = join(folder, 'mcp.json');
const environment = { ...process.env };
const removedTimeoutOverrides = Object.keys(environment).filter(key => /MCP.*TIMEOUT|TIMEOUT.*MCP/i.test(key));
for (const key of removedTimeoutOverrides) delete environment[key];
await writeFile(configuration, JSON.stringify({ mcpServers: { large: { type: 'stdio', command: process.execPath,
  args: ['--max-old-space-size=128', '--import', 'tsx', resolve('tests/large-attachment-fixture.ts')],
  env: { TEST_CACHE_DIR: folder, TEST_METRICS_PATH: metrics, TEST_FILE_BYTES: process.env.TEST_FILE_BYTES ?? '429000000',
    TEST_DELAY_MS: process.env.TEST_DELAY_MS ?? '16' } } } }), { mode: 0o600 });
const child = spawn('claude', ['-p', '--strict-mcp-config', '--mcp-config', configuration, '--setting-sources', '',
  '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence', '--tools', 'Read',
  '--allowedTools', 'mcp__large__get_attachments', 'Read', '--add-dir', folder,
  '--output-format', 'stream-json', '--verbose', '--system-prompt', 'You are a client verification runner. Use only the instructed MCP tool and Read. Do not delegate, execute commands, or change any files.',
  'Call mcp__large__get_attachments exactly once with key SYNTH-1 and ids ["1"]. Wait for completion even if slow. Read the returned preparation.index with limit 1, then Read the responseBody file named by that index, relative to preparation.directory, using offset 10 and limit 3. After both reads return, say VERIFIED. If any tool fails, say FAILED and the reason.'],
  { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const row = claudeAttachment(events);
  const index = JSON.parse((await readFile(row.preparation.index, 'utf8')).trim());
  const verified = validateClaudeLarge(events, code, Number(process.env.TEST_FILE_BYTES ?? '429000000'), (await stat(row.path)).size, index);
  const measurement = JSON.parse(await readFile(metrics, 'utf8'));
  console.log(JSON.stringify({ client: 'Claude Code CLI', code, removedTimeoutOverrides, measurement, ...verified }));
} catch (error) {
  const final = events.findLast(event => event.type === 'result');
  const quota = /hit your (?:session|usage) limit|usage limit reached/i.test(final?.result ?? '');
  console.log(JSON.stringify({ client: 'Claude Code CLI', verified: false, removedTimeoutOverrides,
    connected: events.find(event => event.type === 'system' && event.subtype === 'init')?.mcp_servers?.some((server: { name: string; status: string }) => server.name === 'large' && server.status === 'connected'),
    failure: quota ? 'Claude session usage limit reached before tool execution.' : stderr.includes('login') ? 'Claude authentication unavailable.' :
      error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'Client verification failed.' }));
  process.exitCode = 1;
} finally { clearTimeout(timeout); await rm(folder, { recursive: true, force: true }); }
