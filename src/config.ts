import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

export interface Config {
  siteUrl: string; email: string; token: string; cloudId?: string;
  attachmentDir: string; sessionId: string; readOnly: boolean;
  maxFileBytes: number; maxCallBytes: number; timeoutMs: number;
}

export async function loadConfig(args = process.argv.slice(2), env = process.env): Promise<Config> {
  if (args.length && (args.length !== 2 || args[0] !== '--env-file')) {
    throw new Error('Usage: jira-mcp [--env-file /absolute/path/.env]');
  }
  let file: Record<string, string | undefined> = {};
  if (args[1]) {
    try { file = parseEnv(await readFile(args[1], 'utf8')); }
    catch { throw new Error('Cannot read --env-file. Check the path and permissions.'); }
  }
  const values = { ...file, ...env };
  const required = (name: string) => {
    const value = values[name]?.trim();
    if (!value || value.includes('${')) throw new Error(`${name} is required.`);
    return value;
  };
  const positive = (name: string, fallback: number) => {
    const n = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`);
    return n;
  };
  let site: URL;
  try { site = new URL(required('JIRA_BASE_URL')); }
  catch { throw new Error('JIRA_BASE_URL must be an HTTPS Jira Cloud site URL.'); }
  if (site.protocol !== 'https:' || !site.hostname.endsWith('.atlassian.net') || site.port ||
      site.username || site.password || site.search || site.hash || site.pathname !== '/') {
    throw new Error('JIRA_BASE_URL must be https://your-company.atlassian.net');
  }
  const email = required('JIRA_EMAIL');
  if (!/^[^\s:@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('JIRA_EMAIL must be an email address.');
  const token = required('JIRA_API_TOKEN');
  if (/\s/.test(token)) throw new Error('JIRA_API_TOKEN must not contain whitespace.');
  const cloudId = values.JIRA_CLOUD_ID?.trim() || undefined;
  if (cloudId && !/^[a-zA-Z0-9-]{1,100}$/.test(cloudId)) throw new Error('JIRA_CLOUD_ID is malformed.');
  const sessionId = values.JIRA_SESSION_ID?.trim() || randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error('JIRA_SESSION_ID must contain 1–80 letters, digits, underscores or hyphens.');
  const ro = values.JIRA_READ_ONLY ?? 'false';
  if (!['true', 'false'].includes(ro)) throw new Error('JIRA_READ_ONLY must be true or false.');
  return {
    siteUrl: site.origin, email, token, cloudId, sessionId, readOnly: ro === 'true',
    attachmentDir: resolve(args[1] ? dirname(resolve(args[1])) : process.cwd(), required('JIRA_ATTACHMENT_DIR')),
    maxFileBytes: positive('JIRA_MAX_FILE_BYTES', 50_000_000),
    maxCallBytes: positive('JIRA_MAX_CALL_BYTES', 200_000_000),
    timeoutMs: positive('JIRA_TIMEOUT_MS', 30_000),
  };
}
