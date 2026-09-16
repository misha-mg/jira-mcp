import type { Config } from '../src/config.js';
import { JiraClient, type Fetch } from '../src/jira/client.js';
import { toAdf } from '../src/adf.js';
import type { Issue } from '../src/jira/types.js';

export const config: Config = {
  siteUrl: 'https://example.atlassian.net', email: 'test@example.com', token: 'test-secret-token', cloudId: 'test-cloud',
  attachmentDir: '/unused', sessionId: 'test-session', readOnly: false, maxFileBytes: 50_000_000, maxCallBytes: 200_000_000, timeoutMs: 1000,
};
export const issue: Issue = { key: 'DEMO-8901', fields: {
  summary: 'Test issue', status: { name: 'In Progress' }, issuetype: { name: 'Task' },
  priority: { name: 'Medium' }, labels: ['test'], fixVersions: [{ name: '1.0' }],
  description: toAdf('A small description\nwith a second line.'),
  attachment: [{ id: '101', filename: 'screen.png', mimeType: 'image/png', size: 4 }], updated: '2026-09-16T12:00:00Z',
} };
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export function mockClient(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, overrides: Partial<Config> = {}) {
  return new JiraClient({ ...config, ...overrides }, ((url, init) => Promise.resolve(handler(new URL(String(url)), init ?? {}))) as Fetch);
}
