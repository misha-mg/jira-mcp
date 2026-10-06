import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { parser, type Token } from 'stream-json/parser.js';
import { SafeError } from './jira/errors.js';

const FIELD_LIMIT = 1024;
const MAX_LINE = 2000;
const BUFFER_SIZE = 64 * 1024;
const OPTIONS = { packValues: false, streamValues: true };
type Event = { kind: 'start' | 'chunk' | 'end'; path: string[]; type: string; value?: string | boolean | null; truncated?: boolean };

// Track structure and bounded scalar previews; never assemble an object, key, or string.
class Paths {
  private stack: { type: string; path: string[]; key: string; index: number }[] = [];
  private key = false;
  private keyText = '';
  private keyTooLong = false;
  private scalar?: { path: string[]; type: string; value: string; truncated: boolean };
  constructor(private visit: (event: Event) => void | Promise<void>) {}
  private path() {
    const parent = this.stack.at(-1);
    return parent ? [...parent.path, parent.type === 'array' ? String(parent.index) : parent.key] : [];
  }
  private done() { const parent = this.stack.at(-1); if (parent?.type === 'array') parent.index++; }
  async token(token: Token) {
    switch (token.name) {
      case 'startKey': this.key = true; this.keyText = ''; this.keyTooLong = false; break;
      case 'endKey': {
        this.stack.at(-1)!.key = this.keyTooLong ? '\0' : this.keyText;
        this.key = false; break;
      }
      case 'startObject': case 'startArray': {
        if (this.stack.length >= 128) throw new SafeError('HAR JSON nesting limit exceeded.');
        const type = token.name === 'startObject' ? 'object' : 'array';
        const path = this.path();
        await this.visit({ kind: 'start', path, type });
        this.stack.push({ type, path, key: '', index: 0 }); break;
      }
      case 'endObject': case 'endArray': {
        const frame = this.stack.pop()!;
        await this.visit({ kind: 'end', path: frame.path, type: frame.type });
        this.done(); break;
      }
      case 'startString': case 'startNumber': {
        const type = token.name === 'startString' ? 'string' : 'number';
        this.scalar = { path: this.path(), type, value: '', truncated: false };
        await this.visit({ kind: 'start', path: this.scalar.path, type }); break;
      }
      case 'stringChunk': case 'numberChunk': {
        if (this.key) {
          if (this.keyText.length + token.value.length > 256) this.keyTooLong = true;
          this.keyText = (this.keyText + token.value).slice(0, 256);
        } else {
          const scalar = this.scalar!;
          if (scalar.value.length + token.value.length > FIELD_LIMIT) scalar.truncated = true;
          scalar.value = (scalar.value + token.value).slice(0, FIELD_LIMIT);
          await this.visit({ kind: 'chunk', path: scalar.path, type: scalar.type, value: token.value });
        }
        break;
      }
      case 'endString': case 'endNumber': {
        const scalar = this.scalar!;
        await this.visit({ kind: 'end', ...scalar });
        this.scalar = undefined; this.done(); break;
      }
      case 'trueValue': case 'falseValue': case 'nullValue': {
        await this.visit({ kind: 'end', path: this.path(), type: 'literal', value: token.value });
        this.done(); break;
      }
    }
  }
}

async function parseFile(path: string, visit: (event: Event) => void | Promise<void>, signal?: AbortSignal) {
  const paths = new Paths(visit);
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await pipeline(source.createReadStream({ highWaterMark: BUFFER_SIZE }),
    parser.asStream(OPTIONS), new Writable({ objectMode: true, write(token: Token, _encoding, callback) {
      paths.token(token).then(() => callback(), callback);
    } }), { signal }); } finally { await source.close(); }
}

async function privateFile(path: string) {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

// Buffer small token fragments and retain a dangling UTF-16 surrogate until the next fragment.
class BodyWriter {
  bytes = 0;
  private pending = '';
  private surrogate = '';
  constructor(private handle: FileHandle) {}
  async write(text: string) {
    text = this.surrogate + text;
    this.surrogate = /[\uD800-\uDBFF]$/.test(text) ? text.slice(-1) : '';
    if (this.surrogate) text = text.slice(0, -1);
    this.bytes += Buffer.byteLength(text);
    this.pending += text;
    if (this.pending.length >= BUFFER_SIZE) { await this.handle.writeFile(this.pending); this.pending = ''; }
  }
  async finish() {
    if (this.surrogate) { this.bytes += Buffer.byteLength(this.surrogate); this.pending += this.surrogate; }
    await this.handle.writeFile(this.pending); await this.handle.close();
  }
}

type RpcInfo = { rpcMethod?: string; path?: string; th?: string | number | boolean | null; 'params.method'?: string;
  error: boolean | null; errorText?: string; errorReason?: string; truncatedFields: string[] };

async function rpc(path: string, response: boolean, signal?: AbortSignal): Promise<RpcInfo> {
  const info: RpcInfo = { error: null, truncatedFields: [] };
  let batch = false, records = 0, unknown = false, anyError = false;
  let record: { id: boolean; result: boolean; error: boolean } | undefined;
  const texts: string[] = [];
  const add = (key: keyof RpcInfo, value: unknown, truncated?: boolean) => {
    // Batch request previews use the first occurrence; all response elements are checked.
    if (info[key] === undefined) (info as Record<string, unknown>)[key] = value;
    if (truncated && !info.truncatedFields.includes(key)) info.truncatedFields.push(key);
  };
  try {
    await parseFile(path, event => {
      const p = event.path;
      if (!p.length && event.kind === 'start' && event.type === 'array') batch = true;
      const isRecord = batch ? p.length === 1 : p.length === 0;
      if (isRecord && event.kind === 'start' && event.type === 'object') {
        record = { id: false, result: false, error: false }; records++;
      } else if (batch && isRecord && event.kind === 'start' && event.type === 'array') unknown = true;
      else if (isRecord && event.kind === 'end' && event.type === 'object') {
        if (!record || !record.id || !(record.result || record.error)) unknown = true;
        if (record?.error) anyError = true;
        record = undefined;
      } else if (isRecord && event.kind === 'end' && !['object', 'array'].includes(event.type)) unknown = true;
      const parts = batch ? p.slice(1) : p;
      if (parts.some(part => part.includes('.'))) return;
      const key = parts.join('.');
      if (record) {
        if (parts.length === 1 && key === 'id') record.id = true;
        if (parts.length === 1 && key === 'result') record.result = true;
        if (parts.length === 1 && key === 'error' && event.kind !== 'chunk') {
          if (event.kind === 'start' && ['object', 'array'].includes(event.type)) record.error = true;
          if (event.kind === 'end' && !['object', 'array'].includes(event.type) && event.value !== null) {
            record.error = true;
          }
        }
      }
      if (event.kind !== 'end' || ['object', 'array'].includes(event.type)) return;
      if (!response) {
        if (key === 'method') add('rpcMethod', event.value, event.truncated);
        if (key === 'params.path' || key === 'path') add('path', event.value, event.truncated);
        if (key === 'params.th' || key === 'th') add('th', event.type === 'number' ? Number(event.value) : event.value, event.truncated);
        if (key === 'params.method') add('params.method', event.value, event.truncated);
      } else if (key === 'error.message' || key === 'error.data' || key.startsWith('error.data.')) {
        if (event.value !== null && event.value !== undefined && texts.join(' | ').length < FIELD_LIMIT) {
          texts.push(String(event.value));
          if (event.truncated || texts.join(' | ').length > FIELD_LIMIT) {
            if (!info.truncatedFields.includes('errorText')) info.truncatedFields.push('errorText');
          }
        }
      }
    }, signal);
    if (response) {
      info.error = anyError ? true : records > 0 && !unknown ? false : null;
      if (unknown || !records) info.errorReason = 'Not every element is a recognizable JSON-RPC response.';
      if (texts.length) info.errorText = texts.join(' | ').slice(0, FIELD_LIMIT);
    }
  } catch (error) {
    if (signal?.aborted) throw new SafeError('Attachment operation cancelled.');
    // A damaged/unsupported body is retained. It cannot establish absence of an RPC error.
    info.error = null;
    info.errorReason = error instanceof SafeError ? error.message : 'Body is not valid JSON; JSON-RPC error check unavailable.';
  }
  return info;
}

// Read uses line offsets: add structural newlines to JSON-looking bodies and bound every line,
// including huge JSON string values. This is an explicitly labelled text view, not a JSON copy.
async function readableBody(path: string, encoding?: string, signal?: AbortSignal) {
  const temporary = `${path}.readable`;
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let handle: FileHandle;
  try { handle = await privateFile(temporary); }
  catch (error) { await source.close(); throw error; }
  const writer = new BodyWriter(handle);
  const decoder = new StringDecoder('utf8');
  let json: boolean | undefined, quoted = false, escaped = false, line = 0, formatted = false, lineWrapped = false;
  const format = (text: string) => {
    let output = '';
    for (const character of text) {
      if (json === undefined && !/\s/.test(character)) json = !encoding && (character === '{' || character === '[');
      if (line + character.length > MAX_LINE && character !== '\n') { output += '\n'; line = 0; lineWrapped = true; }
      output += character;
      line = character === '\n' ? 0 : line + character.length;
      if (json) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if ('{},[]'.includes(character)) { output += '\n'; line = 0; formatted = true; }
      }
    }
    return output;
  };
  try {
    for await (const chunk of source.createReadStream({ signal })) {
      await writer.write(format(decoder.write(chunk as Buffer)));
    }
    await writer.write(format(decoder.end())); await writer.finish();
    await rename(temporary, path);
    return { formatted, lineWrapped, representation: formatted || lineWrapped ? 'readable-text-view' : 'original-text', storedBytes: writer.bytes };
  } finally { await source.close(); await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

function safeUrl(value: string) {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`.slice(0, FIELD_LIMIT); }
  catch { return '[unparseable or truncated URL]'; }
}

export async function prepareHar(source: string, directory: string, signal?: AbortSignal): Promise<{ count: number }> {
  await mkdir(join(directory, 'entries'), { mode: 0o700 });
  const index = await privateFile(join(directory, 'index.jsonl'));
  let count = 0, entriesSeen = false;
  let row: Record<string, unknown> | undefined;
  let active: { side: 'request' | 'response'; writer: BodyWriter; handle: FileHandle; path: string } | undefined;
  const bodies: Partial<Record<'request' | 'response', string>> = {};
  const truncated = new Set<string>();
  try {
    await parseFile(source, async event => {
      const p = event.path;
      if (p.length === 2 && p[0] === 'log' && p[1] === 'entries' && event.kind === 'start') {
        if (event.type !== 'array' || entriesSeen) throw new SafeError('HAR must contain one log.entries array.');
        entriesSeen = true;
      }
      if (p[0] !== 'log' || p[1] !== 'entries' || p.length < 3) return;
      if (p.length === 3 && event.kind === 'start' && event.type === 'object') {
        row = { entry: ++count, error: null, errorReason: 'Response body unavailable.' };
        delete bodies.request; delete bodies.response; truncated.clear(); return;
      }
      if (!row) throw new SafeError('HAR entry is not an object.');
      if (p.slice(3).some(part => part.includes('.'))) return;
      const field = p.slice(3).join('.');
      const side = field === 'request.postData.text' ? 'request' : field === 'response.content.text' ? 'response' : undefined;
      if (side && event.type === 'string') {
        if (event.kind === 'start') {
          if (bodies[side]) throw new SafeError('Duplicate HAR body field.');
          const relative = `entries/${String(count).padStart(4, '0')}.${side}.txt`;
          const path = join(directory, relative); const handle = await privateFile(path);
          active = { side, handle, writer: new BodyWriter(handle), path }; bodies[side] = path;
          row[`${side}Body`] = relative;
        } else if (event.kind === 'chunk') await active!.writer.write(String(event.value));
        else { await active!.writer.finish(); row[`${side}Bytes`] = active!.writer.bytes; active = undefined; }
        return;
      }
      if (event.kind === 'end' && p.length === 3 && event.type === 'object') {
        if (bodies.request) {
          const request = await rpc(bodies.request, false, signal);
          for (const key of ['rpcMethod', 'path', 'th', 'params.method'] as const) if (request[key] !== undefined) row[key] = request[key];
          request.truncatedFields.forEach(key => truncated.add(key));
          row.requestView = await readableBody(bodies.request, undefined, signal);
        }
        if (!row.rpcMethod && typeof row.url === 'string') row.rpcMethod = /\/jsonrpc\/([^/?#]+)/.exec(row.url)?.[1];
        if (bodies.response) {
          if (row.responseEncoding) {
            row.error = null; row.errorReason = 'Encoded response body; JSON-RPC error check unavailable (no automatic decoding).';
          } else {
            const result = await rpc(bodies.response, true, signal);
            row.error = result.error;
            if (result.errorReason) row.errorReason = result.errorReason; else delete row.errorReason;
            if (result.errorText) row.errorText = result.errorText;
            result.truncatedFields.forEach(key => truncated.add(key));
          }
          row.responseView = await readableBody(bodies.response, row.responseEncoding as string | undefined, signal);
        }
        if (truncated.size) row.truncatedFields = [...truncated];
        await index.writeFile(JSON.stringify(row) + '\n'); row = undefined; return;
      }
      if (event.kind !== 'end' || ['array', 'object'].includes(event.type)) return;
      const fields: Record<string, string> = { startedDateTime: 'startedDateTime', time: 'timeMs',
        'request.method': 'method', 'request.url': 'url', 'response.status': 'status', 'response.content.encoding': 'responseEncoding' };
      const key = Object.hasOwn(fields, field) ? fields[field] : undefined;
      if (key) {
        row[key] = key === 'url' ? safeUrl(String(event.value)) : event.type === 'number' ? Number(event.value) : event.value;
        if (event.truncated) truncated.add(key);
      }
    }, signal);
    if (!entriesSeen || row) throw new SafeError('HAR is missing a complete log.entries array.');
    return { count };
  } finally { await active?.handle.close().catch(() => {}); await index.close(); }
}
