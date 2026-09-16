import { z } from 'zod';
import { keySchema } from './get-issue.js';
import type { JiraClient } from '../jira/client.js';
import { SafeError } from '../jira/errors.js';
import { toAdf } from '../adf.js';
import { jsonOutput, short } from '../output.js';

export const transitionIssueSchema = z.object({ key: keySchema, to: z.string().trim().min(1).max(200), resolution: z.string().trim().min(1).max(200).optional(), comment: z.string().min(1).max(32767).optional() });
export async function transitionIssue(client: JiraClient, args: z.infer<typeof transitionIssueSchema>) {
  const { transitions } = await client.transitions(args.key);
  const matching = transitions.filter(t => t.to.name.toLowerCase() === args.to.toLowerCase());
  if (!matching.length) throw new SafeError(short(`Unavailable target status. Available: ${[...new Set(transitions.map(t => t.to.name))].join(', ') || '(none)'}`, 180));
  if (matching.length > 1) throw new SafeError('Multiple transitions lead to that status. Use Jira to choose the transition.');
  const transition = matching[0]!;
  const fields: Record<string, unknown> = {};
  const unsupported = Object.entries(transition.fields ?? {}).filter(([key, f]) => key !== 'resolution' && f.required && !f.hasDefaultValue).map(([key]) => key);
  if (unsupported.length) throw new SafeError(short(`Transition requires unsupported fields: ${unsupported.join(', ')}. Complete it in Jira.`, 180));
  const resolutionField = transition.fields?.resolution;
  if (resolutionField?.required && !args.resolution) {
    throw new SafeError(short(`resolution is required. Available: ${resolutionField.allowedValues?.map(v => v.name).join(', ') || 'check the workflow in Jira'}`, 180));
  }
  if (args.resolution) {
    if (!resolutionField) throw new SafeError('This transition does not expose a resolution field.');
    const allowed = resolutionField.allowedValues ?? await client.resolutions();
    const choices = allowed.filter(v => v.name.toLowerCase() === args.resolution!.toLowerCase() || v.id === args.resolution);
    if (choices.length !== 1 || !choices[0]?.id) throw new SafeError(short(`Invalid or ambiguous resolution. Available: ${allowed.map(v => v.name).join(', ')}`, 180));
    fields.resolution = { id: choices[0].id };
  }
  await client.transition(args.key, {
    transition: { id: transition.id }, ...(Object.keys(fields).length ? { fields } : {}),
    ...(args.comment ? { update: { comment: [{ add: { body: toAdf(args.comment) } }] } } : {}),
  });
  return jsonOutput({ status: short(transition.to.name, 20), confirmation: 'Transition applied.' }, 50);
}
