import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toAdf } from '../src/adf.js';
import { createServer } from '../src/server.js';
import { config, mockClient, issue, json } from './helpers.js';
const conf = { ...config, readOnly: process.env.TEST_READ_ONLY === 'true' };
const client = mockClient((url, init) => {
  if (init.method === 'POST') return json({ id: '101' });
  if (url.pathname.endsWith('/search/jql')) return json({ issues: [issue], isLast: true });
  if (url.pathname.endsWith('/issue/DEMO-9999')) return json({ ...issue, fields: { ...issue.fields, description: toAdf('Complete requirement. '.repeat(5000)) } });
  return json(issue);
}, conf);
await createServer(conf, client).connect(new StdioServerTransport());
