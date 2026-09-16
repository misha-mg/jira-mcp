import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { addComment } from '../src/tools/add-comment.js';
import { transitionIssue } from '../src/tools/transition-issue.js';
import { config, issue, json, mockClient } from './helpers.js';

test('config validation: explicit env file resolves paths and environment overrides it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jira-config-'));
  try {
    await writeFile(join(folder, '.env'), `JIRA_BASE_URL=https://example.atlassian.net\nJIRA_EMAIL=test@example.com\nJIRA_API_TOKEN=secret\nJIRA_ATTACHMENT_DIR=files\nJIRA_READ_ONLY=true`);
    const c = await loadConfig(['--env-file', join(folder, '.env')], { JIRA_READ_ONLY: 'false' });
    assert.equal(c.attachmentDir, join(folder, 'files'));
    assert.equal(c.readOnly, false);
    await assert.rejects(loadConfig([], {}), /JIRA_BASE_URL/);
    await assert.rejects(loadConfig(['--env-file', join(folder, '.env')], { JIRA_READ_ONLY: 'yes' }), /JIRA_READ_ONLY/);
    await assert.rejects(loadConfig(['--env-file', join(folder, '.env')], { JIRA_SESSION_ID: '../escape' }), /JIRA_SESSION_ID/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('attachment directory defaults to an absolute user cache, with explicit overrides preserved', async () => {
  const env = { JIRA_BASE_URL: config.siteUrl, JIRA_EMAIL: config.email, JIRA_API_TOKEN: config.token };
  for (const XDG_CACHE_HOME of [undefined, '', 'relative/cache', '${CACHE}']) {
    assert.equal((await loadConfig([], { ...env, XDG_CACHE_HOME })).attachmentDir, join(homedir(), '.cache', 'jira-mcp'));
  }
  const cache = join(tmpdir(), 'jira-cache-test');
  assert.equal((await loadConfig([], { ...env, XDG_CACHE_HOME: cache })).attachmentDir, join(cache, 'jira-mcp'));
  assert.equal((await loadConfig([], { ...env, XDG_CACHE_HOME: cache, JIRA_ATTACHMENT_DIR: '  ' })).attachmentDir, join(cache, 'jira-mcp'));
  assert.equal((await loadConfig([], { ...env, JIRA_ATTACHMENT_DIR: cache })).attachmentDir, cache);
  await assert.rejects(loadConfig([], { ...env, JIRA_ATTACHMENT_DIR: '${JIRA_ATTACHMENT_DIR}' }), /unresolved variable/);
});
test('default attachment directory is independent of the env file checkout', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jira-config-'));
  try {
    const values = `JIRA_BASE_URL=${config.siteUrl}\nJIRA_EMAIL=${config.email}\nJIRA_API_TOKEN=${config.token}`;
    await mkdir(join(folder, 'main'));
    await mkdir(join(folder, 'worktree'));
    await writeFile(join(folder, 'main', '.env'), values);
    await writeFile(join(folder, 'worktree', '.env'), values);
    const a = await loadConfig(['--env-file', join(folder, 'main', '.env')], {});
    const b = await loadConfig(['--env-file', join(folder, 'worktree', '.env')], {});
    assert.equal(a.attachmentDir, join(homedir(), '.cache', 'jira-mcp'));
    assert.equal(a.attachmentDir, b.attachmentDir);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('scoped gateway and auth, cloud discovery without credentials', async () => {
  let discovery = 0;
  const client = mockClient((url, init) => {
    if (url.pathname === '/_edge/tenant_info') {
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      discovery++; return json({ cloudId: 'abc-123' });
    }
    assert.equal(url.hostname, 'api.atlassian.com');
    assert.ok(url.pathname.startsWith('/ex/jira/abc-123/rest/api/3/'));
    assert.equal(new Headers(init.headers).get('Authorization'), `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`);
    return json(issue);
  }, { cloudId: undefined });
  await client.getIssue('DEMO-8901'); await client.getIssue('DEMO-8901');
  assert.equal(discovery, 1);
});
test('HTTP errors hide response bodies and redirects are refused', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const client = mockClient(() => json({ error: config.token }, status));
    await assert.rejects(client.getIssue('DEMO-8901'), e => e instanceof Error && !e.message.includes(config.token));
  }
  const redirect = mockClient(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }));
  await assert.rejects(redirect.download('101'), /redirect refused/);
});
test('add_comment emits literal-text ADF and never retries uncertain writes', async () => {
  let count = 0;
  const client = mockClient((_url, init) => {
    count++;
    assert.equal(init.method, 'POST');
    assert.equal(JSON.parse(String(init.body)).body.content[0].content[0].text, '**literal**');
    return json({ id: '123' });
  });
  assert.equal(JSON.parse(await addComment(client, { key: 'DEMO-8901', body: '**literal**' })).id, '123');
  assert.equal(count, 1);
  const failed = mockClient(() => { count++; throw new Error('socket error with secret'); });
  await assert.rejects(addComment(failed, { key: 'DEMO-8901', body: 'x' }), /Outcome uncertain/);
  assert.equal(count, 2);
});
const transitions = [
  { id: '21', name: 'ToDo', to: { name: 'To Do' } },
  { id: '61', name: 'Ready For Testing', to: { name: 'Ready To Test' }, fields: { resolution: { required: true, allowedValues: [{ id: '1', name: 'Done' }] } } },
  { id: '121', name: 'Done', to: { name: 'Done' }, fields: { resolution: { required: true, allowedValues: [{ id: '1', name: 'Done' }] } } },
  { id: '161', name: 'Deferred', to: { name: 'Deferred' } },
];
test('workflow resolves destination status and sends resolution + comment atomically', async () => {
  const writes: unknown[] = [];
  const client = mockClient((_url, init) => {
    if (init.method === 'POST') { writes.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    return json({ transitions });
  });
  await assert.rejects(transitionIssue(client, { key: 'DEMO-8901', to: 'Ready For Testing' }), /Ready To Test/);
  await assert.rejects(transitionIssue(client, { key: 'DEMO-8901', to: 'Done' }), /resolution is required/);
  await assert.rejects(transitionIssue(client, { key: 'DEMO-8901', to: 'Done', resolution: 'Wrong' }), /Invalid/);
  assert.equal(writes.length, 0);
  const result = await transitionIssue(client, { key: 'DEMO-8901', to: 'Ready To Test', resolution: 'Done', comment: 'Verified' });
  assert.equal(JSON.parse(result).status, 'Ready To Test');
  assert.deepEqual(writes[0], { transition: { id: '61' }, fields: { resolution: { id: '1' } }, update: { comment: [{ add: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Verified' }] }] } } }] } });
  await transitionIssue(client, { key: 'DEMO-8901', to: 'Deferred' });
  assert.deepEqual(writes[1], { transition: { id: '161' } });
});
test('ambiguous or unsupported transitions do not write', async () => {
  for (const list of [[transitions[0], transitions[0]], [{ id: '1', name: 'x', to: { name: 'To Do' }, fields: { customfield_123: { required: true } } }]]) {
    const client = mockClient((_url, init) => { assert.equal(init.method, 'GET'); return json({ transitions: list }); });
    await assert.rejects(transitionIssue(client, { key: 'DEMO-8901', to: 'To Do' }), /Multiple|unsupported/);
  }
});
test('read-only client blocks both write endpoints before HTTP', async () => {
  const client = mockClient(() => { throw new Error('must not fetch'); }, { readOnly: true });
  await assert.rejects(client.addComment('DEMO-8901', { type: 'doc' }), /disabled/);
  await assert.rejects(client.transition('DEMO-8901', {}), /disabled/);
});
