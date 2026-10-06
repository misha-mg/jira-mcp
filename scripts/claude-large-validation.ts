import assert from 'node:assert/strict';
import { join } from 'node:path';

type Event = Record<string, any>;
const parts = (events: Event[], type: string, partType: string) => events
  .flatMap(event => event.type === type ? event.message?.content ?? [] : [])
  .filter(part => part.type === partType);

function successfulResult(events: Event[], id: string) {
  const results = parts(events, 'user', 'tool_result').filter(part => part.tool_use_id === id);
  assert.equal(results.length, 1, 'Expected exactly one result for each requested tool call.');
  assert.ok(!results[0].is_error, 'Requested tool call failed.');
  return results[0];
}

export function claudeAttachment(events: Event[]) {
  const calls = parts(events, 'assistant', 'tool_use').filter(part => part.name === 'mcp__large__get_attachments');
  assert.equal(calls.length, 1, 'Expected one attachment call.');
  assert.deepEqual(calls[0].input, { key: 'SYNTH-1', ids: ['1'] });
  const result = successfulResult(events, calls[0].id);
  const text = typeof result.content === 'string' ? result.content : result.content
    .filter((part: Event) => part.type === 'text').map((part: Event) => part.text).join('\n');
  const row = JSON.parse(text.split('\n')[0]);
  assert.ok(row.path && !row.skipped, 'Original download was not completed.');
  assert.equal(row.preparation?.kind, 'har');
  assert.equal(row.preparation.count, 1);
  assert.ok(row.preparation.index && row.preparation.directory && !row.preparation.skipped, 'HAR preparation was not completed.');
  return row;
}

export function validateClaudeLarge(events: Event[], code: number | null, expectedBytes: number, actualBytes: number, index: Event) {
  assert.equal(code, 0, 'Claude CLI did not exit successfully.');
  const init = events.find(event => event.type === 'system' && event.subtype === 'init');
  assert.ok(init?.mcp_servers?.some((server: Event) => server.name === 'large' && server.status === 'connected'));
  const final = events.findLast(event => event.type === 'result');
  assert.ok(final && !final.is_error);
  assert.match(final.result ?? '', /\bVERIFIED\b/);
  const row = claudeAttachment(events);
  assert.equal(row.size, expectedBytes);
  assert.equal(actualBytes, expectedBytes);
  assert.equal(index.error, false);
  assert.equal(index.rpcMethod, 'get_schema');
  assert.equal(index.path, '/synthetic');
  assert.ok(index.responseBody && index.responseView?.lineWrapped);
  const reads = parts(events, 'assistant', 'tool_use').filter(part => part.name === 'Read');
  assert.equal(reads.length, 2, 'Expected exactly the two instructed Read calls.');
  assert.equal(reads[0].input?.file_path, row.preparation.index, 'Read must use the returned index path.');
  assert.equal(reads[0].input?.limit, 1);
  assert.equal(reads[1].input?.file_path, join(row.preparation.directory, index.responseBody), 'Read must use the indexed response body.');
  assert.equal(reads[1].input?.offset, 10); assert.equal(reads[1].input?.limit, 3);
  for (const read of reads) successfulResult(events, read.id);
  assert.equal(parts(events, 'user', 'tool_result').filter(part => part.is_error).length, 0);
  return { verified: true, readRanges: reads.map(part => ({ offset: part.input.offset, limit: part.input.limit })) };
}
