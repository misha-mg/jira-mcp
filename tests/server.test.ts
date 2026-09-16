import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { tokens } from '../src/output.js';

test('real entrypoint connects with incomplete/invalid settings and returns errors through every tool', async () => {
  const base = { JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'test@example.com' };
  const cases = [
    { env: {}, args: [], expected: /JIRA_BASE_URL is not set/, count: 5 },
    { env: base, args: [], expected: /JIRA_API_TOKEN is not set/, count: 5 },
    { env: { ...base, JIRA_READ_ONLY: 'true' }, args: [], expected: /JIRA_API_TOKEN is not set/, count: 3 },
    { env: { ...base, JIRA_READ_ONLY: 'typo' }, args: [], expected: /JIRA_READ_ONLY must be/, count: 3 },
    { env: {}, args: ['--env-file', '/nonexistent/jira-mcp-test/.env'], expected: /Cannot read --env-file/, count: 3 },
    { env: {}, args: ['--unknown'], expected: /Usage: jira-mcp/, count: 3 },
  ];
  for (const { env, args, expected, count } of cases) {
    // Do not inherit developer credentials: these calls must never reach Jira.
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', '--', resolve('src/index.ts'), ...args], env, stderr: 'pipe' });
    const client = new Client({ name: 'unconfigured-test', version: '1' });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, count);
      const inputs = [
        ['get_issue', { key: 'DEMO-1' }], ['search_issues', { jql: 'project = DEMO' }],
        ['get_attachments', { key: 'DEMO-1' }],
        ...(count === 5 ? [['add_comment', { key: 'DEMO-1', body: 'test' }], ['transition_issue', { key: 'DEMO-1', to: 'Done' }]] : []),
      ] as Array<[string, Record<string, string>]>;
      for (const [name, args] of inputs) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), expected);
      }
      assert.equal((await client.listTools()).tools.length, count, 'server remains connected after errors');
    } finally { await client.close(); }
  }
});

test('MCP startup does not access the attachment directory', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/index.ts')], env: {
    JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'dummy',
    JIRA_ATTACHMENT_DIR: resolve('package.json'), // A file cannot be used as a directory.
  }, stderr: 'pipe' });
  const client = new Client({ name: 'unwritable-directory-test', version: '1' });
  try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 5); }
  finally { await client.close(); }
});

for (const readOnly of [true, false]) {
  test(`MCP handshake, tools/list and tools/call: readOnly=${readOnly}`, async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('tests/fixture-server.ts')], env: { ...process.env as Record<string, string>, TEST_READ_ONLY: String(readOnly) }, stderr: 'pipe' });
    const client = new Client({ name: 'test-client', version: '1' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, readOnly ? 3 : 5);
      if (!readOnly) {
        const count = tokens(JSON.stringify(tools));
        console.log(`Full tool definitions: ${count} cl100k_base tokens`);
        assert.ok(count <= 700, 'schema should stay compact');
      }
      const result = await client.callTool({ name: 'get_issue', arguments: { key: 'DEMO-8901' } });
      assert.ok(!result.isError);
      assert.match(JSON.stringify(result.content), /Test issue/);
      const large = await client.callTool({ name: 'get_issue', arguments: { key: 'DEMO-9999' } });
      assert.ok(!large.isError);
      const textBlock = (large.content as Array<{ type: string; text: string }>).find(c => c.type === 'text')!;
      assert.equal(JSON.parse(textBlock.text).description, 'Complete requirement. '.repeat(5000).trim());
      const bad = await client.callTool({ name: 'get_issue', arguments: { key: '../../x' } });
      assert.equal(bad.isError, true);
      if (readOnly) {
        await assert.rejects(client.callTool({ name: 'add_comment', arguments: { key: 'DEMO-8901', body: 'hello' } }), /not found/);
        await assert.rejects(client.callTool({ name: 'transition_issue', arguments: { key: 'DEMO-8901', to: 'Done' } }), /not found/);
      } else {
        const write = await client.callTool({ name: 'add_comment', arguments: { key: 'DEMO-8901', body: 'hello' } });
        assert.ok(!write.isError);
      }
    } finally { await client.close(); }
  });
}
