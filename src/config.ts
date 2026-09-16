import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

export interface Config {
  siteUrl: string; email: string; token: string; cloudId?: string;
  attachmentDir: string; sessionId: string; readOnly: boolean;
  maxFileBytes: number; maxCallBytes: number; timeoutMs: number;
}

// Only authored messages may be exposed to MCP clients; never include env values.
export class ConfigError extends Error {
  constructor(message: string, readonly readOnly = true) { super(message); }
}

export async function loadConfig(args = process.argv.slice(2), env = process.env): Promise<Config> {
  if (args.length && (args.length !== 2 || args[0] !== '--env-file')) {
    throw new ConfigError('Usage: jira-mcp [--env-file /absolute/path/.env]');
  }
  let file: Record<string, string | undefined> = {};
  if (args[1]) {
    try { file = parseEnv(await readFile(args[1], 'utf8')); }
    catch { throw new ConfigError('Cannot read --env-file. Check the path and permissions.'); }
  }
  const values = { ...file, ...env };
  const ro = values.JIRA_READ_ONLY ?? 'false';
  const invalid = (message: string): never => { throw new ConfigError(message, ro !== 'false'); };
  if (!['true', 'false'].includes(ro)) invalid('JIRA_READ_ONLY must be true or false.');
  const required = (name: string) => {
    const value = values[name]?.trim();
    if (!value || value.includes('${')) return invalid(`${name} is not set. Set it in the process environment or --env-file, then restart the MCP server.`);
    return value;
  };
  const positive = (name: string, fallback: number) => {
    const n = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isSafeInteger(n) || n <= 0) invalid(`${name} must be a positive integer.`);
    return n;
  };
  let site: URL;
  const baseUrl = required('JIRA_BASE_URL');
  try { site = new URL(baseUrl); }
  catch { return invalid('JIRA_BASE_URL must be an HTTPS Jira Cloud site URL.'); }
  if (site.protocol !== 'https:' || !site.hostname.endsWith('.atlassian.net') || site.port ||
      site.username || site.password || site.search || site.hash || site.pathname !== '/') {
    invalid('JIRA_BASE_URL must be https://your-company.atlassian.net');
  }
  const email = required('JIRA_EMAIL');
  if (!/^[^\s:@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('JIRA_EMAIL must be an email address.');
  const token = required('JIRA_API_TOKEN');
  if (/\s/.test(token)) invalid('JIRA_API_TOKEN must not contain whitespace.');
  const cloudId = values.JIRA_CLOUD_ID?.trim() || undefined;
  if (cloudId && !/^[a-zA-Z0-9-]{1,100}$/.test(cloudId)) invalid('JIRA_CLOUD_ID is malformed.');
  const sessionId = values.JIRA_SESSION_ID?.trim() || randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) invalid('JIRA_SESSION_ID must contain 1–80 letters, digits, underscores or hyphens.');
  const attachmentDir = values.JIRA_ATTACHMENT_DIR?.trim();
  if (attachmentDir?.includes('${')) invalid('JIRA_ATTACHMENT_DIR contains an unresolved variable. Remove it to use the default cache directory, or set a path.');
  // XDG requires an absolute path. Ignore relative/unexpanded values so the
  // default never depends on the checkout or worktree's working directory.
  const xdg = values.XDG_CACHE_HOME;
  const cacheHome = xdg && isAbsolute(xdg) && !xdg.includes('${') ? xdg : join(homedir(), '.cache');
  return {
    siteUrl: site.origin, email, token, cloudId, sessionId, readOnly: ro === 'true',
    attachmentDir: attachmentDir
      ? resolve(args[1] ? dirname(resolve(args[1])) : process.cwd(), attachmentDir)
      : join(cacheHome, 'jira-mcp'),
    maxFileBytes: positive('JIRA_MAX_FILE_BYTES', 50_000_000),
    maxCallBytes: positive('JIRA_MAX_CALL_BYTES', 200_000_000),
    timeoutMs: positive('JIRA_TIMEOUT_MS', 30_000),
  };
}
