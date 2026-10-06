import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
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
  const tar = extract();
  let bytes = 0, count = 0, skipped = 0;
  const seen = new Set<string>();
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length; budget.remainingBytes -= chunk.length;
    callback(budget.remainingBytes < 0 ? new SafeError('Archive expanded byte limit exceeded.') : null, chunk);
  } });
  // Meter the actual GZIP output, including discarded entries, padding and metadata.
  const transfer = pipeline(input.createReadStream(), createGunzip(), counter, tar, { signal });
  // Attach a rejection handler immediately, while the entry consumer awaits filesystem writes.
  transfer.catch(() => {});
  const consume = async () => {
    for await (const entry of tar) {
      signal?.throwIfAborted();
      if (++count > maxEntries) throw new SafeError('Archive entry limit exceeded.');
      const header = entry.header;
      if (!Number.isSafeInteger(header.size) || header.size < 0) throw new SafeError('Invalid archive entry size.');
      let reason = unsafePath(header.name);
      if (!['file', 'directory'].includes(header.type)) reason ??= 'links and special or unsupported entries refused';
      if (header.pax && Object.keys(header.pax).some(key => /sparse/i.test(key))) reason ??= 'sparse entries unsupported';
      const target = resolve(root, header.name);
      if (target !== root && !target.startsWith(root + sep)) reason ??= 'path escapes extraction directory';
      if (target === root && header.type !== 'directory') reason ??= 'entry conflicts with extraction root';
      const normalized = relative(root, target);
      if (seen.has(normalized)) reason ??= 'duplicate path refused';
      let handle: FileHandle | undefined;
      if (!reason) {
        try {
          await parents(root, header.type === 'directory' ? target : dirname(target));
          if (await realpath(dirname(target)) !== resolve(dirname(target))) throw new SafeError('Unsafe archive parent directory.');
          if (header.type === 'file') handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
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
        size, type: header.type ?? 'unknown', classification: header.type === 'file' ? classification(Buffer.concat(samples), size) : 'unknown',
        ...(reason ? { skipped: reason } : { extractedPath: `files${normalized ? '/' + normalized.split(sep).join('/') : ''}` }) }) + '\n');
    }
  };
  const consumption = consume();
  try {
    await Promise.all([transfer, consumption]);
    return { count, bytes, skipped };
  } catch (error) {
    tar.destroy(error as Error); counter.destroy(error as Error);
    await Promise.allSettled([transfer, consumption]);
    if (signal?.aborted) throw new SafeError('Attachment operation cancelled.');
    throw error instanceof SafeError ? error : new SafeError('Archive is damaged or its TAR format is unsupported.');
  } finally { await input.close(); await index.close(); }
}
