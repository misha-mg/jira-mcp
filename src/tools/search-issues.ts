import { z } from 'zod';
import type { JiraClient } from '../jira/client.js';

export const searchIssuesSchema = z.object({ jql: z.string().min(1).max(8000), limit: z.number().int().min(1).max(50).optional() });
export async function searchIssues(client: JiraClient, args: z.infer<typeof searchIssuesSchema>) {
  const limit = args.limit ?? 10;
  const page = await client.search(args.jql, limit);
  const lines = page.issues.slice(0, limit).map(issue => JSON.stringify({
    key: issue.key, summary: issue.fields.summary ?? '', status: issue.fields.status?.name ?? '',
    type: issue.fields.issuetype?.name ?? '', updated: issue.fields.updated,
  }));
  const hasMore = page.isLast === false || Boolean(page.nextPageToken) || page.issues.length > limit;
  return [...lines, JSON.stringify({ shown: lines.length, has_more: hasMore, ...(hasMore ? { note: 'Narrow JQL for more results.' } : {}) })].join('\n');
}
