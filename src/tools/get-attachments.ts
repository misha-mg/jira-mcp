import { z } from 'zod';
import { keySchema } from './get-issue.js';
import type { JiraClient } from '../jira/client.js';
import type { AttachmentStore } from '../attachments.js';
import { SafeError } from '../jira/errors.js';

export const getAttachmentsSchema = z.object({ key: keySchema, ids: z.array(z.string().regex(/^\d+$/).max(30)).min(1).max(100).optional() });
export async function getAttachments(client: JiraClient, store: AttachmentStore, args: z.infer<typeof getAttachmentsSchema>) {
  const issue = await client.getIssue(args.key, 'attachment');
  const files = issue.fields.attachment ?? [];
  if (args.ids?.some(id => !files.some(file => file.id === id))) throw new SafeError('Some attachment IDs do not belong to this issue. Call get_issue to check the index.');
  return store.download(client, args.key, args.ids ? files.filter(f => args.ids!.includes(f.id)) : files);
}
