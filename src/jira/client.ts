import type { Config } from '../config.js';
import type { CommentPage, Issue, Named, SearchPage, Transition, AdfNode } from './types.js';
import { httpError, SafeError } from './errors.js';

export type Fetch = typeof fetch;
export class JiraClient {
  private cloudId?: Promise<string>;
  constructor(readonly config: Config, private readonly fetcher: Fetch = fetch) {}

  private async request(url: string, method = 'GET', body?: unknown, authenticated = true): Promise<Response> {
    if (method !== 'GET' && this.config.readOnly) throw new SafeError('Write operations are disabled.');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: 'application/json',
          ...(authenticated ? { Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64')}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new SafeError(method === 'GET' ? 'Jira network request failed or timed out.' :
        'Jira write request failed or timed out. Outcome uncertain; verify in Jira before retrying.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) throw new SafeError('Unexpected Jira redirect refused; credentials were not forwarded.');
      throw httpError(response.status, method !== 'GET');
    }
    return response;
  }

  private async json<T>(response: Response, maxBytes = 8_000_000): Promise<T> {
    if (response.status === 204) return undefined as T;
    const reader = response.body?.getReader();
    if (!reader) throw new SafeError('Jira returned an empty response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new SafeError('Jira response exceeds the 8 MB safety limit. Narrow the request.');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof SafeError) throw error;
      throw new SafeError('Jira returned unreadable data or the response was interrupted.');
    } finally { reader.releaseLock(); }
  }

  async getCloudId(): Promise<string> {
    if (this.config.cloudId) return this.config.cloudId;
    this.cloudId ??= (async () => {
      const result = await this.json<{ cloudId?: string }>(await this.request(`${this.config.siteUrl}/_edge/tenant_info`, 'GET', undefined, false));
      if (!result.cloudId || !/^[a-zA-Z0-9-]{1,100}$/.test(result.cloudId)) throw new SafeError('Could not discover cloud ID. Set JIRA_CLOUD_ID.');
      return result.cloudId;
    })();
    try { return await this.cloudId; } catch (error) { this.cloudId = undefined; throw error; }
  }

  private async api<T>(path: string, query: Record<string, string> = {}, method = 'GET', body?: unknown, maxResponseBytes = 8_000_000): Promise<T> {
    const url = await this.url(path, query);
    return this.json<T>(await this.request(url, method, body), maxResponseBytes);
  }
  private async url(path: string, query: Record<string, string>): Promise<string> {
    return `https://api.atlassian.com/ex/jira/${await this.getCloudId()}/rest/api/3/${path}?${new URLSearchParams(query)}`;
  }
  getIssue(key: string, fields = 'summary,status,issuetype,priority,labels,fixVersions,description,attachment') {
    return this.api<Issue>(`issue/${encodeURIComponent(key)}`, { fields }, 'GET', undefined, Infinity);
  }
  comments(key: string, start: number) {
    return this.api<CommentPage>(`issue/${encodeURIComponent(key)}/comment`, { startAt: String(start), maxResults: '100', orderBy: '+created' }, 'GET', undefined, Infinity);
  }
  search(jql: string, limit: number) {
    return this.api<SearchPage>('search/jql', { jql, maxResults: String(limit), fields: 'summary,status,issuetype,updated' });
  }
  addComment(key: string, body: AdfNode) {
    return this.api<{ id: string }>(`issue/${encodeURIComponent(key)}/comment`, {}, 'POST', { body });
  }
  transitions(key: string) {
    return this.api<{ transitions: Transition[] }>(`issue/${encodeURIComponent(key)}/transitions`, { expand: 'transitions.fields' });
  }
  resolutions() { return this.api<Named[]>('resolution'); }
  transition(key: string, body: unknown) {
    return this.api<void>(`issue/${encodeURIComponent(key)}/transitions`, {}, 'POST', body);
  }
  async download(id: string): Promise<Response> {
    if (!/^\d+$/.test(id)) throw new SafeError('Invalid attachment ID.');
    return this.request(await this.url(`attachment/content/${id}`, { redirect: 'false' }));
  }
}
