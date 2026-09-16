import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokens } from '../src/output.js';

// --live reads the real ticket and downloads attachments. It never writes to Jira.
// --command npx --args <...> exercises a locally packed or published package.
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const issueAt = argv.indexOf('--issue');
const issueKey = issueAt >= 0 ? argv[issueAt + 1] : undefined;
if (live && (!issueKey || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey))) {
  throw new Error('Live testing requires --issue PROJECT-123.');
}
const commandAt = argv.indexOf('--command');
const argsAt = argv.indexOf('--args');
const envAt = argv.indexOf('--env-file');
const folder = await mkdtemp(join(tmpdir(), 'jira-smoke-'));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const environment = live ? { ...env, JIRA_READ_ONLY: 'true' } : {
  ...env, JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_CLOUD_ID: 'offline', JIRA_EMAIL: 'test@example.com',
  JIRA_API_TOKEN: 'offline-not-a-real-token', JIRA_READ_ONLY: 'true', JIRA_ATTACHMENT_DIR: folder,
};
const command = commandAt >= 0 ? argv[commandAt + 1]! : process.execPath;
const args = argsAt >= 0 ? argv.slice(argsAt + 1) : [resolve('dist/index.js'), ...(live ? ['--env-file', resolve(envAt >= 0 ? argv[envAt + 1]! : '.env')] : [])];
const transport = new StdioClientTransport({ command, args, env: environment, cwd: folder, stderr: 'inherit' });
const client = new Client({ name: 'jira-mcp-smoke', version: '1' });
try {
  await client.connect(transport);
  const list = await client.listTools();
  if (list.tools.length !== 3) throw new Error('Expected three read-only tools.');
  console.log(`MCP connected; tools: ${list.tools.map(t => t.name).join(', ')}; ${tokens(JSON.stringify(list.tools))} reference tokens.`);
  if (live) {
    for (const [name, args] of [
      ['get_issue', { key: issueKey!, comments: true }],
      ['search_issues', { jql: `key = ${issueKey!}` }],
      ['get_attachments', { key: issueKey! }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      console.log(JSON.stringify({ tool: name, result }, null, 2));
      if (result.isError) throw new Error(`${name} failed.`);
    }
  }
} finally { await client.close(); await rm(folder, { recursive: true, force: true }); }
