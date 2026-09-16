import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { tokens } from '../src/output.js';

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
