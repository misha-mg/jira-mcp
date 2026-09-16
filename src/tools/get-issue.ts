import { z } from 'zod';
import type { JiraClient } from '../jira/client.js';
import { SafeError } from '../jira/errors.js';
import { fromAdf } from '../adf.js';
import { serialize } from '../output.js';

export const keySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/).max(100).transform(s => s.toUpperCase());
export const getIssueSchema = z.object({ key: keySchema, comments: z.boolean().optional() }).strict();

export async function getIssue(client: JiraClient, args: z.infer<typeof getIssueSchema>) {
  const issue = await client.getIssue(args.key);
  const f = issue.fields;
  const result = {
    key: args.key, summary: f.summary ?? '', status: f.status?.name ?? '',
    type: f.issuetype?.name ?? '', priority: f.priority?.name ?? null,
    labels: f.labels ?? [], fixVersions: (f.fixVersions ?? []).map(v => v.name),
    description: fromAdf(f.description).trim(),
    attachments: (f.attachment ?? []).map(a => ({
      id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size,
    })),
  };
  if (!args.comments) return serialize(result);

  const comments: Array<{ author: string; created: string; body: string }> = [];
  const seen = new Set<string>();
  let start = 0;
  let total: number | undefined;
  // Jira paginates internally. Return only after every page has been collected.
  // Oldest-first keeps new comments from shifting already-read page positions.
  while (true) {
    const page = await client.comments(args.key, start);
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.startAt !== start || !Array.isArray(page.comments)) {
      throw new SafeError('Jira returned invalid comment pagination; no partial issue was returned.');
    }
    total ??= page.total;
    if (page.total !== total) throw new SafeError('Comments changed during retrieval. Retry get_issue; no partial issue was returned.');
    for (const comment of page.comments) {
      if (!comment.id || seen.has(comment.id)) throw new SafeError('Comment pages overlap or changed. Retry get_issue; no partial issue was returned.');
      seen.add(comment.id);
      comments.push({ author: comment.author?.displayName ?? 'Unknown', created: comment.created, body: fromAdf(comment.body).trim() });
    }
    start += page.comments.length;
    if (start === total) break;
    if (start > total || !page.comments.length) throw new SafeError('Jira returned incomplete comment pages; no partial issue was returned.');
  }
  return serialize({ ...result, comments, comments_total: comments.length });
}
