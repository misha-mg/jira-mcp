import test from 'node:test';
import assert from 'node:assert/strict';
import { fromAdf, toAdf } from '../src/adf.js';
import { getIssue } from '../src/tools/get-issue.js';
import { searchIssues, searchIssuesSchema } from '../src/tools/search-issues.js';
import { tokens } from '../src/output.js';
import { issue, json, mockClient } from './helpers.js';

test('plain text ADF roundtrip preserves paragraphs, Unicode and literal markdown', () => {
  const text = 'Привет 👋\n\n**literal**\r\nend';
  assert.equal(fromAdf(toAdf(text)).trimEnd(), text.replace(/\r\n/g, '\n'));
  assert.equal(fromAdf({ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] }).trim(), 'link (https://example.com)');
});
test('normal issue is projected and under 800 reference tokens', async () => {
  const client = mockClient(() => json({ ...issue, self: 'secret-url', author: { avatarUrls: ['noise'] } }));
  const output = await getIssue(client, { key: issue.key });
  assert.ok(tokens(output) <= 800);
  const parsed = JSON.parse(output);
  assert.equal(parsed.description, 'A small description\nwith a second line.');
  assert.equal(parsed.attachments[0].id, '101');
  assert.doesNotMatch(output, /avatarUrls|secret-url|"content"/);
});
test('long issue returns the complete description, metadata and attachment index in one response', async () => {
  const description = 'Данные 👨‍💻 and text\n'.repeat(4000).trim();
  const summary = 'Long summary '.repeat(200);
  const labels = Array.from({ length: 30 }, (_, i) => `label-${i}`);
  const files = Array.from({ length: 100 }, (_, i) => ({ id: String(i), filename: 'screenshot'.repeat(30), mimeType: 'image/png', size: 10 }));
  const client = mockClient(() => json({ ...issue, fields: { ...issue.fields, summary, labels,
    fixVersions: labels.map(name => ({ name })), description: toAdf(description), attachment: files,
  } }));
  const output = await getIssue(client, { key: issue.key });
  const parsed = JSON.parse(output);
  assert.equal(parsed.description, description);
  assert.equal(parsed.summary, summary);
  assert.deepEqual(parsed.labels, labels);
  assert.deepEqual(parsed.fixVersions, labels);
  assert.deepEqual(parsed.attachments, files);
  assert.ok(tokens(output) > 4000);
  assert.equal(parsed.next, undefined);
  assert.equal(parsed.comments, undefined);
});
test('all comments and their full bodies are collected across Jira pages', async () => {
  const body = 'Long comment with requirements. '.repeat(800).trim();
  const comments = Array.from({ length: 23 }, (_, i) => ({ id: String(i), created: '2026-09-16', body: toAdf(`${i}: ${body}`), author: { displayName: 'Full author name '.repeat(30) } }));
  const starts: number[] = [];
  const client = mockClient(url => {
    if (!url.pathname.endsWith('/comment')) return json(issue);
    assert.equal(url.searchParams.get('maxResults'), '100');
    assert.equal(url.searchParams.get('orderBy'), '+created');
    const start = Number(url.searchParams.get('startAt')); starts.push(start);
    // Jira can return a smaller page than requested.
    return json({ total: comments.length, startAt: start, comments: comments.slice(start, start + 7) });
  });
  const parsed = JSON.parse(await getIssue(client, { key: issue.key, comments: true }));
  assert.deepEqual(starts, [0, 7, 14, 21]);
  assert.equal(parsed.comments_total, 23);
  assert.deepEqual(parsed.comments, comments.map(c => ({ author: c.author.displayName, created: c.created, body: fromAdf(c.body).trim() })));
  assert.equal(parsed.next, undefined);
});
test('issue and comment HTTP bodies larger than the old 8 MB cap are returned whole', async () => {
  const text = 'x'.repeat(8_000_100);
  const client = mockClient(url => url.pathname.endsWith('/comment')
    ? json({ total: 1, startAt: 0, comments: [{ id: '1', created: '2026-09-16', body: toAdf(text) }] })
    : json({ ...issue, fields: { ...issue.fields, description: toAdf(text) } }));
  const parsed = JSON.parse(await getIssue(client, { key: issue.key, comments: true }));
  assert.equal(parsed.description, text);
  assert.equal(parsed.comments[0].body, text);
});
test('empty comment collection is complete', async () => {
  const client = mockClient(url => url.pathname.endsWith('/comment') ? json({ startAt: 0, total: 0, comments: [] }) : json(issue));
  const parsed = JSON.parse(await getIssue(client, { key: issue.key, comments: true }));
  assert.deepEqual(parsed.comments, []);
  assert.equal(parsed.comments_total, 0);
});
test('failed, missing, overlapping or changing pages cannot produce a partial success', async () => {
  const comment = { id: '1', created: '2026-09-16', body: toAdf('First comment') };
  const badResponses = [
    () => json({}, 500),
    () => json({ startAt: 1, total: 2, comments: [] }),
    () => json({ startAt: 1, total: 2, comments: [comment] }),
    () => json({ startAt: 1, total: 3, comments: [{ ...comment, id: '2' }] }),
    () => json({ startAt: 0, total: 2, comments: [{ ...comment, id: '2' }] }),
  ];
  for (const bad of badResponses) {
    const client = mockClient(url => {
      if (!url.pathname.endsWith('/comment')) return json(issue);
      if (url.searchParams.get('startAt') === '0') return json({ startAt: 0, total: 2, comments: [comment] });
      return bad();
    });
    await assert.rejects(getIssue(client, { key: issue.key, comments: true }));
  }
});
test('search returns requested 10 or 50 issues without shortening fields or a token cap', async () => {
  const summary = 'Long summary with Unicode 👨‍💻 '.repeat(100);
  const status = 'Long workflow status '.repeat(40);
  const type = 'Long issue type '.repeat(40);
  for (const limit of [10, 50]) {
    const issues = Array.from({ length: limit }, (_, i) => ({ ...issue, key: `DEMO-${i + 1}`,
      fields: { ...issue.fields, summary, status: { name: status }, issuetype: { name: type } },
    }));
    const client = mockClient(url => {
      assert.ok(url.pathname.endsWith('/search/jql'));
      assert.equal(url.searchParams.get('maxResults'), String(limit));
      return json({ issues, isLast: false, nextPageToken: 'cursor' });
    });
    const output = await searchIssues(client, { jql: 'project = DEMO', ...(limit === 50 ? { limit } : {}) });
    const rows = output.split('\n').map(line => JSON.parse(line));
    const meta = rows.pop();
    assert.equal(rows.length, limit);
    assert.equal(meta.shown, limit);
    assert.equal(meta.has_more, true);
    assert.deepEqual(rows, issues.map(i => ({ key: i.key, summary, status, type, updated: i.fields.updated })));
    assert.ok(tokens(output) > 1500);
    assert.doesNotMatch(output, /description|attachment|nextPageToken|\[truncated\]/);
  }
});
test('search handles empty/fewer results and enforces its count limit', async () => {
  for (const count of [0, 3, 12]) {
    const client = mockClient(() => json({ issues: Array.from({ length: count }, () => issue), isLast: true }));
    const rows = (await searchIssues(client, { jql: 'project = DEMO' })).split('\n').map(line => JSON.parse(line));
    const meta = rows.pop();
    assert.equal(rows.length, Math.min(count, 10));
    assert.equal(meta.shown, rows.length);
    assert.equal(meta.has_more, count > 10);
  }
  for (const limit of [0, 51, 1.5]) assert.equal(searchIssuesSchema.safeParse({ jql: 'project = DEMO', limit }).success, false);
});
