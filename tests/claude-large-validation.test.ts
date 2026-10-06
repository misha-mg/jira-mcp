import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClaudeLarge } from '../scripts/claude-large-validation.js';

const size = 429_000_000;
const index = { error: false, rpcMethod: 'get_schema', path: '/synthetic', responseBody: 'entries/0001.response.txt', responseView: { lineWrapped: true } };
function fixture() {
  const attachment = { path: '/cache/synthetic.har', size, preparation: { kind: 'har', count: 1, directory: '/cache/synthetic.har.har', index: '/cache/synthetic.har.har/index.jsonl' } };
  const calls = [
    { type: 'tool_use', id: 'download', name: 'mcp__large__get_attachments', input: { key: 'SYNTH-1', ids: ['1'] } },
    { type: 'tool_use', id: 'index', name: 'Read', input: { file_path: attachment.preparation.index, limit: 1 } },
    { type: 'tool_use', id: 'body', name: 'Read', input: { file_path: '/cache/synthetic.har.har/entries/0001.response.txt', offset: 10, limit: 3 } },
  ];
  const results = calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, is_error: false,
    content: call.id === 'download' ? [{ type: 'text', text: JSON.stringify(attachment) }] : 'read succeeded' }));
  const events = [{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'large', status: 'connected' }] },
    ...calls.flatMap((call, i) => [{ type: 'assistant', message: { content: [call] } }, { type: 'user', message: { content: [results[i]] } }]),
    { type: 'result', result: 'VERIFIED', is_error: false }];
  return { events, calls, results, attachment };
}

test('Claude check requires the successful download and reads of the exact returned paths', () => {
  const { events } = fixture();
  assert.equal(validateClaudeLarge(events, 0, size, size, index).verified, true);
  assert.throws(() => validateClaudeLarge(events, 0, size, size - 1, index));
  assert.throws(() => validateClaudeLarge(events, 1, size, size, index));
  assert.throws(() => validateClaudeLarge(events, 0, size, size, { ...index, error: null }));
  for (const which of [1, 2]) {
    const f = fixture(); f.calls[which]!.input.file_path = '/unrelated/file';
    assert.throws(() => validateClaudeLarge(f.events, 0, size, size, index));
  }
});

test('Claude check rejects missing/failed results and skipped preparation despite a VERIFIED message', () => {
  for (const which of [0, 1, 2]) {
    const f = fixture(); f.results[which]!.is_error = true;
    assert.throws(() => validateClaudeLarge(f.events, 0, size, size, index));
    const missing = fixture(); missing.events.splice(2 + 2 * which, 1);
    assert.throws(() => validateClaudeLarge(missing.events, 0, size, size, index));
  }
  const f = fixture();
  f.results[0]!.content = [{ type: 'text', text: JSON.stringify({ ...f.attachment, preparation: { kind: 'har', skipped: 'failed' } }) }];
  assert.throws(() => validateClaudeLarge(f.events, 0, size, size, index));
  // Claude can return a success exit/result even when account quota prevents all tool calls.
  assert.throws(() => validateClaudeLarge([{ type: 'result', result: "You've hit your session limit", is_error: false }], 0, size, size, index));
});
