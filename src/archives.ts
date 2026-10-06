import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Parser, type ReadEntry } from 'tar';
import { SafeError } from './jira/errors.js';

export type ArchiveBudget = { remainingBytes: number };

function unsafePath(name: string): string | undefined {
  if (isAbsolute(name) || win32.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return 'absolute path refused';
  if (name.includes('\\') || name.split('/').includes('..')) return 'path traversal or backslash refused';
  if (/[\x00-\x1f\x7f]/.test(name) || name.length > 4096 || !name) return 'invalid or excessive path';
}

async function parents(root: string, target: string) {
  const parts = relative(root, target).split(sep).filter(Boolean);
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SafeError('Archive directory conflicts with an existing file or unsafe path.');
  }
}

function classification(sample: Buffer, size: number) {
  if (!size) return 'unknown';
  if (sample.includes(0) || sample.some(byte => byte < 9 || byte > 13 && byte < 32)) return 'binary';
  try {
    // A sample ending mid-codepoint is allowed; invalid complete UTF-8 is binary.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < size });
    return 'text';
  } catch { return 'binary'; }
}

export async function prepareArchive(source: string, directory: string, budget: ArchiveBudget, maxEntries: number, signal?: AbortSignal) {
  const files = join(directory, 'files');
  await mkdir(files, { mode: 0o700 });
  const root = await realpath(files);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let index: FileHandle;
  try { index = await open(join(directory, 'index.jsonl'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { await input.close(); throw error; }
  const tar = new Parser({ maxMetaEntrySize: 1024 * 1024, brotli: false, zstd: false });
  let eof = false;
  tar.on('eof', () => { eof = true; });
  let bytes = 0, count = 0, skipped = 0;
  const seen = new Set<string>();
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length; budget.remainingBytes -= chunk.length;
    callback(budget.remainingBytes < 0 ? new SafeError('Archive expanded byte limit exceeded.') : null, chunk);
  } });
  const active = new Set<ReadEntry>();
  let consumption = Promise.resolve();
  let parserEnded!: () => void;
  const parsed = new Promise<void>(resolve => { parserEnded = resolve; });
  tar.once('end', parserEnded);
  let prefix: Buffer = Buffer.alloc(0), started = false;
  // Adapt the library's writable parser to Node pipeline, preserving backpressure and aborts.
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        // The library auto-detects GZIP even with other codecs disabled. Refuse
        // nested compression so every extracted byte passes through our meter.
        if (!started) {
          chunk = Buffer.concat([prefix, chunk]);
          if (chunk.length < 2) { prefix = chunk; callback(); return; }
          prefix = Buffer.alloc(0); started = true;
          if (chunk[0] === 0x1f && chunk[1] === 0x8b) {
            callback(new SafeError('Nested archive compression is unsupported.')); return;
          }
        }
        // Parser buffers bytes following EOF; discard them here while the
        // upstream meter and GZIP stream still enforce volume and integrity.
        if (eof || tar.write(chunk)) callback(); else tar.once('drain', callback);
      }
      catch (error) { callback(error as Error); }
    },
    final(callback) {
      try { tar.end(prefix); parsed.then(() => consumption).then(() => callback(), callback); }
      catch (error) { callback(error as Error); }
    },
    destroy(error, callback) {
      if (error) {
        for (const entry of active) entry.destroy(error);
        tar.abort(error);
      }
      callback(error);
    },
  });
  tar.on('error', () => sink.destroy(new SafeError('Archive is damaged or its TAR metadata is unsupported.')));
  tar.on('warn', (code: string, message: string) => {
    // node-tar warns even for a legal empty archive ending in two null blocks.
    // Every other warning is fatal, including malformed headers and truncated bodies.
    if (code === 'TAR_BAD_ARCHIVE' && message === 'Unrecognized archive format' && eof && count === 0) return;
    sink.destroy(new SafeError('Archive is damaged or its TAR metadata is unsupported.'));
  });
  // node-tar intentionally omits unknown PAX attributes. Reject sparse markers from its
  // bounded metadata event before those attributes can disappear; no custom TAR/PAX decoder.
  tar.on('meta', (metadata: string) => {
    if (/(?:^|\n)\d+ (?:GNU\.sparse[.=]|SCHILY\.(?:realsize|filetype=sparse))/.test(metadata)) {
      sink.destroy(new SafeError('Sparse archive metadata is unsupported.'));
    }
  });
  const accept = (entry: ReadEntry) => {
    try {
      signal?.throwIfAborted();
      if (++count > maxEntries) throw new SafeError('Archive entry limit exceeded.');
      // Refuse global PAX instead of ignoring its path/unknown attributes.
      if (entry.globalExtended) throw new SafeError('Global PAX metadata is unsupported.');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new SafeError('Invalid archive entry size.');
      return true;
    } catch (error) { sink.destroy(error as Error); return false; }
  };
  const consume = async (entry: ReadEntry) => {
    const header = { name: entry.path, size: entry.size, type: entry.type };
    let reason = unsafePath(header.name);
    if (!['File', 'OldFile', 'Directory'].includes(header.type)) reason ??= 'links and special or unsupported entries refused';
    const target = resolve(root, header.name);
    if (target !== root && !target.startsWith(root + sep)) reason ??= 'path escapes extraction directory';
    if (target === root && header.type !== 'Directory') reason ??= 'entry conflicts with extraction root';
    const normalized = relative(root, target);
    if (seen.has(normalized)) reason ??= 'duplicate path refused';
    let handle: FileHandle | undefined;
    if (!reason) {
      try {
        await parents(root, header.type === 'Directory' ? target : dirname(target));
        if (await realpath(dirname(target)) !== resolve(dirname(target))) throw new SafeError('Unsafe archive parent directory.');
        if (['File', 'OldFile'].includes(header.type)) handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        seen.add(normalized);
      } catch (error) {
        if (error instanceof SafeError || ['EEXIST', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) reason = 'existing path or directory/file conflict refused';
        else throw error;
      }
    }
    let size = 0;
    const samples: Buffer[] = []; let sampleSize = 0;
    try {
      for await (const chunk of entry) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (sampleSize < 8192) {
          const sample = buffer.subarray(0, 8192 - sampleSize); samples.push(sample); sampleSize += sample.length;
        }
        await handle?.writeFile(buffer);
      }
      if (size !== header.size) throw new SafeError('Archive entry size mismatch or truncated archive.');
    } finally { await handle?.close(); }
    if (reason) skipped++;
    await index.writeFile(JSON.stringify({ path: header.name.slice(0, 4096), ...(header.name.length > 4096 ? { pathTruncated: true } : {}),
      size, type: header.type ?? 'unknown', classification: ['File', 'OldFile'].includes(header.type) ? classification(Buffer.concat(samples), size) : 'unknown',
      ...(reason ? { skipped: reason } : { extractedPath: `files${normalized ? '/' + normalized.split(sep).join('/') : ''}` }) }) + '\n');
  };
  tar.on('entry', (entry: ReadEntry) => {
    active.add(entry);
    entry.on('error', () => {});
    if (!accept(entry)) return;
    consumption = consumption.then(() => consume(entry)).finally(() => active.delete(entry));
    consumption.catch(error => sink.destroy(error as Error));
  });
  tar.on('ignoredEntry', (entry: ReadEntry) => {
    if (entry.meta) { sink.destroy(new SafeError('Archive metadata size limit exceeded.')); return; }
    if (!accept(entry)) return;
    // The library drains unsupported entries; index the refusal while it validates their length.
    consumption = consumption.then(async () => {
      skipped++;
      await index.writeFile(JSON.stringify({ path: entry.path.slice(0, 4096), ...(entry.path.length > 4096 ? { pathTruncated: true } : {}),
        size: entry.size, type: entry.type, classification: 'unknown', skipped: 'unsupported entry type refused' }) + '\n');
    });
    consumption.catch(error => sink.destroy(error as Error));
  });
  // Meter actual GZIP output, including discarded entries, padding and metadata.
  const transfer = pipeline(input.createReadStream(), createGunzip(), counter, sink, { signal });

  try {
    await Promise.all([transfer, consumption]);
    return { count, bytes, skipped };
  } catch (error) {
    sink.destroy(error as Error); counter.destroy(error as Error);
    await Promise.allSettled([transfer, consumption]);
    if (signal?.aborted) throw new SafeError('Attachment operation cancelled.');
    throw error instanceof SafeError ? error : new SafeError('Archive is damaged or its TAR format is unsupported.');
  } finally { await input.close(); await index.close(); }
}
