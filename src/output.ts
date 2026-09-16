import { getEncoding } from 'js-tiktoken';
import { SafeError } from './jira/errors.js';

// A reproducible reference metric, not a claim about Claude's private tokenizer.
const encoding = getEncoding('cl100k_base');
export const tokens = (text: string) => encoding.encode(text, [], []).length;
export const serialize = (value: unknown) => JSON.stringify(value);
export function excerpt(text: string, offset: number, budget: number) {
  const remaining = text.slice(offset);
  if (tokens(serialize(remaining)) <= budget) return { text: remaining, next: undefined };
  let low = 0, high = remaining.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(serialize(remaining.slice(0, mid))) <= budget) low = mid; else high = mid - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(remaining[low - 1]!)) low--;
  return { text: remaining.slice(0, low), next: offset + low };
}
export function short(text: string, budget: number): string {
  const part = excerpt(text, 0, budget);
  return part.text + (part.next === undefined ? '' : '…[truncated]');
}
export function jsonOutput(value: unknown, budget: number): string {
  const result = serialize(value);
  if (tokens(result) > budget) throw new SafeError('Response exceeds its budget. Narrow the request.');
  return result;
}
