import { z } from 'zod';
import { keySchema } from './get-issue.js';
import type { JiraClient } from '../jira/client.js';
import { toAdf } from '../adf.js';
import { jsonOutput } from '../output.js';

export const addCommentSchema = z.object({ key: keySchema, body: z.string().min(1).max(32767).refine(s => s.trim().length > 0) });
export async function addComment(client: JiraClient, args: z.infer<typeof addCommentSchema>) {
  const result = await client.addComment(args.key, toAdf(args.body));
  return jsonOutput({ id: result.id, confirmation: 'Comment added.' }, 50);
}
