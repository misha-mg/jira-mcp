import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentStore } from '../src/attachments.js';
import { JiraClient, type Fetch } from '../src/jira/client.js';
import { config } from './helpers.js';

async function download(handler: (response: ServerResponse) => void, overrides: Partial<typeof config>, action: (store: AttachmentStore, client: JiraClient, folder: string, closed: Promise<void>) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'jira-download-'));
  let closeResponse!: () => void;
  const closed = new Promise<void>(resolve => { closeResponse = resolve; });
  const server = createServer((_request, response) => { response.once('close', closeResponse); handler(response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const conf = { ...config, attachmentDir: folder, ...overrides };
  const client = new JiraClient(conf, ((_url, init) => fetch(`http://127.0.0.1:${address.port}`, { ...init, headers: {} })) as Fetch);
  try { await action(new AttachmentStore(conf), client, folder, closed); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(folder, { recursive: true, force: true }); }
}
const file = { id: '1', filename: 'test.txt', mimeType: 'text/plain', size: 1000 };
const first = (text: string) => JSON.parse(text.split('\n')[0]!);

test('download body outlives the API timeout while real idle/total HTTP aborts remove partial files', async () => {
  await download(response => {
    let sent = 0;
    const timer = setInterval(() => { response.write('a'); if (++sent === 10) { clearInterval(timer); response.end(); } }, 15);
    response.once('close', () => clearInterval(timer));
  }, { timeoutMs: 5, downloadTimeoutMs: 1000, downloadIdleTimeoutMs: 100 }, async (store, client) => {
    const row = first(await store.download(client, 'DEMO-1', [{ ...file, size: 10 }]));
    assert.ok(row.path, row.skipped);
  });
  for (const mode of ['idle', 'total', 'headers']) {
    await download(response => {
      if (mode === 'headers') return;
      response.write('first');
      if (mode === 'total') {
        const timer = setInterval(() => response.write('more'), 10);
        response.once('close', () => clearInterval(timer));
      }
    }, { downloadTimeoutMs: mode === 'total' ? 100 : 1000, downloadIdleTimeoutMs: mode === 'total' ? 500 : 100 }, async (store, client, folder, closed) => {
      const start = performance.now();
      const row = first(await store.download(client, 'DEMO-1', [file]));
      assert.equal(row.path, null); assert.match(row.skipped, mode === 'total' ? /total timeout/ : /idle timeout/);
      assert.ok(performance.now() - start < 2000);
      await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('HTTP socket did not close after abort')), 1000); timer.unref(); })]);
      assert.deepEqual(await readdir(join(folder, config.sessionId, 'DEMO-1')), []);
    });
  }
});

test('actual downloaded bytes consume the call budget even when Jira metadata is wrong', async () => {
  await download(response => response.end('actual'), { maxCallBytes: 8 }, async (store, client) => {
    const rows = (await store.download(client, 'DEMO-1', [{ ...file, size: 2 }, { ...file, id: '2', size: 4 }])).split('\n').map(line => JSON.parse(line));
    assert.match(rows[0].skipped, /size differs/); assert.match(rows[1].skipped, /remaining call limit/);
  });
});

test('caller cancellation aborts an active HTTP download and removes partial bytes', async () => {
  await download(response => { response.write('partial'); }, {}, async (store, client, folder, closed) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 50);
    try { await assert.rejects(store.download(client, 'DEMO-1', [file], controller.signal)); }
    finally { clearTimeout(timer); }
    await closed;
    assert.deepEqual(await readdir(join(folder, config.sessionId, 'DEMO-1')), []);
  });
});
