// Opt-in synthetic fixture for SDK / real Claude Code verification. Never contacts Jira.
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../src/config.js';
import { JiraClient, type Fetch } from '../src/jira/client.js';
import { AttachmentStore } from '../src/attachments.js';
import { createServer } from '../src/server.js';

const size = Number(process.env.TEST_FILE_BYTES ?? 429_000_000);
const schemaBytes = Math.min(Number(process.env.TEST_SCHEMA_BYTES ?? 150_000_000), size - 1000);
const delayMs = Number(process.env.TEST_DELAY_MS ?? 0);
if (![size, schemaBytes, delayMs].every(Number.isSafeInteger) || size < 2000 || schemaBytes < 0 || delayMs < 0) throw new Error('Invalid synthetic fixture settings.');
const cache = process.env.TEST_CACHE_DIR ?? await mkdtemp(join(tmpdir(), 'jira-large-'));
const conf = await loadConfig([], { JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'synthetic-only',
  JIRA_CLOUD_ID: 'synthetic', JIRA_READ_ONLY: 'true', JIRA_SESSION_ID: 'large-test', JIRA_ATTACHMENT_DIR: cache });
const head = '{"log":{"entries":[{"_initiator":{"stack":"';
const middle = '"},"request":{"method":"POST","url":"https://example.com/jsonrpc/get_schema","postData":{"text":"{\\"id\\":1,\\"method\\":\\"get_schema\\",\\"params\\":{\\"path\\":\\"/synthetic\\"}}"}},"response":{"status":200,"content":{"text":"{\\"id\\":1,\\"result\\":{\\"schema\\":\\"';
const tail = '\\"}}"}}}]}}';
const ignoredBytes = size - Buffer.byteLength(head + middle + tail) - schemaBytes;
let downloadStart = 0, downloaded = 0;
let maxHeap = 0, maxRss = 0;
const sample = () => { const memory = process.memoryUsage(); maxHeap = Math.max(maxHeap, memory.heapUsed); maxRss = Math.max(maxRss, memory.rss); };
const sampler = setInterval(sample, 100); sampler.unref();
const server = httpServer((_request, response) => {
  downloadStart = performance.now();
  response.setHeader('Content-Length', size);
  response.on('finish', () => { downloaded = performance.now(); });
  const chunk = Buffer.alloc(64 * 1024, 'x');
  void (async () => {
    const write = async (data: string | Buffer) => {
      if (response.destroyed) throw new Error('Client disconnected.');
      if (!response.write(data)) await once(response, 'drain');
      if (delayMs) await delay(delayMs);
    };
    const repeat = async (length: number) => { while (length > 0) { const n = Math.min(length, chunk.length); await write(chunk.subarray(0, n)); length -= n; } };
    await write(head); await repeat(ignoredBytes); await write(middle); await repeat(schemaBytes); await write(tail); response.end();
  })().catch(() => response.destroy());
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const file = { id: '1', filename: 'synthetic.har', mimeType: 'application/json', size };
const client = new JiraClient(conf, ((url, init) => {
  if (String(url).includes('/attachment/content/')) return fetch(`http://127.0.0.1:${address.port}`, { ...init, headers: {} });
  return Promise.resolve(new Response(JSON.stringify({ key: 'SYNTH-1', fields: { attachment: [file] } })));
}) as Fetch);
class MeasuredStore extends AttachmentStore {
  override async download(...args: Parameters<AttachmentStore['download']>) {
    const start = performance.now();
    try { return await super.download(...args); }
    finally {
      sample();
      if (process.env.TEST_METRICS_PATH) await writeFile(process.env.TEST_METRICS_PATH, JSON.stringify({ size, schemaBytes,
        downloadMs: Math.round(downloaded - downloadStart), preparationMs: Math.round(performance.now() - downloaded),
        callMs: Math.round(performance.now() - start), maxHeapBytes: maxHeap, maxRssBytes: maxRss }), { mode: 0o600 });
    }
  }
}
const transport = new StdioServerTransport();
const mcp = createServer(conf, client, new MeasuredStore(conf));
mcp.server.onclose = () => { clearInterval(sampler); server.closeAllConnections(); server.close(); };
await mcp.connect(transport);
