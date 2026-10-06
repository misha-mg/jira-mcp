import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Attachment } from './jira/types.js';
import type { JiraClient } from './jira/client.js';
import { SafeError } from './jira/errors.js';
import { serialize, short, tokens } from './output.js';
import { frameBudget, isVideo, VideoFrames } from './video-frames.js';
import { prepareHar } from './har.js';
import { prepareArchive, type ArchiveBudget } from './archives.js';

function preparationKind(file: Attachment) {
  if (/\.har$/i.test(file.filename)) return 'har';
  if (/\.(tar\.gz|tgz)$/i.test(file.filename)) return 'tar.gz';
}

type Completion = { id: string; size: number; count: number; bytes?: number; skipped?: number };

export function safeFilename(name: string): string {
  return name.normalize('NFKC').replace(/[\x00-\x1f\x7f/\\:<>"|?*]/g, '_').replace(/\.{2,}/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'attachment';
}

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SafeError('Attachment directory must not be a symlink.');
}

export class AttachmentStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private config: Config, private frames = new VideoFrames(config)) {}

  async prepare() {
    try { await directory(this.config.attachmentDir); await access(this.config.attachmentDir, constants.W_OK); }
    catch (e) { if (e instanceof SafeError) throw e; throw new SafeError('JIRA_ATTACHMENT_DIR cannot be created or accessed.'); }
  }

  download(client: JiraClient, key: string, files: Attachment[], signal?: AbortSignal): Promise<string> {
    // Serialise operations in this server; originals and video frames keep atomic publication.
    const task = this.pending.then(() => this.run(client, key, files, signal));
    this.pending = task.catch(() => {});
    return task;
  }

  private async prepareAttachment(file: Attachment, path: string, kind: 'har' | 'tar.gz', budget: ArchiveBudget, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const folder = `${path}.${kind === 'har' ? 'har' : 'extracted'}`;
    const result = (done: Completion, reused = false) => ({ kind, directory: folder, index: join(folder, 'index.jsonl'),
      count: done.count, ...(done.skipped ? { skippedEntries: done.skipped } : {}), ...(reused ? { reused: true } : {}) });
    try {
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(folder) !== resolve(folder)) throw new SafeError('Unsafe preparation cache directory.');
      let cached: Completion | undefined;
      try {
        const marker = await open(join(folder, '.complete.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await marker.stat();
          if (stat.isFile() && stat.size <= 2048) {
            const buffer = Buffer.alloc(2049); const { bytesRead } = await marker.read(buffer);
            cached = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as Completion;
          }
        } finally { await marker.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new SafeError('Unsafe preparation completion marker.');
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (cached?.id === file.id && cached.size === file.size && Number.isSafeInteger(cached.count) && cached.count >= 0 &&
          (kind === 'har' || Number.isSafeInteger(cached.bytes) && cached.bytes! >= 0 && cached.count <= this.config.maxArchiveEntries)) {
        let complete = true;
        for (const name of ['index.jsonl', kind === 'har' ? 'entries' : 'files']) {
          try {
            const stat = await lstat(join(folder, name));
            if (stat.isSymbolicLink() || (name === 'index.jsonl' ? !stat.isFile() : !stat.isDirectory())) throw new SafeError('Unsafe preparation cache contents.');
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') complete = false; else throw error; }
        }
        if (complete && kind === 'tar.gz') {
          if (cached.bytes! > budget.remainingBytes) throw new SafeError('Archive expanded byte limit exceeded.');
          budget.remainingBytes -= cached.bytes!;
        }
        if (complete) return result(cached, true);
      }
      await rm(folder, { recursive: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(folder, { mode: 0o700 });
    try {
      const prepared = kind === 'har' ? await prepareHar(path, folder, signal) : await prepareArchive(path, folder, budget, this.config.maxArchiveEntries, signal);
      signal?.throwIfAborted();
      const done: Completion = { id: file.id, size: file.size, ...prepared };
      const marker = await open(join(folder, '.complete.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await marker.writeFile(JSON.stringify(done)); } finally { await marker.close(); }
      return result(done);
    } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
  }

  private async run(client: JiraClient, key: string, files: Attachment[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new SafeError('Invalid issue key.');
    await this.prepare();
    const root = await realpath(this.config.attachmentDir);
    const session = join(root, this.config.sessionId);
    await directory(session);
    const folder = join(session, key);
    await directory(folder);
    if (await realpath(folder) !== resolve(folder)) throw new SafeError('Unsafe attachment directory.');
    let remaining = this.config.maxCallBytes;
    const videoBudget = frameBudget();
    const archiveBudget = { remainingBytes: this.config.maxExtractedBytes };
    const rows: string[] = [];
    let processed = 0;
    for (const file of files) {
      signal?.throwIfAborted();
      if (!/^\d+$/.test(file.id) || !Number.isSafeInteger(file.size) || file.size < 0) throw new SafeError('Jira returned invalid attachment metadata.');
      const filename = `${file.id}-${safeFilename(file.filename)}`;
      const path = join(folder, filename);
      const info = { id: file.id, path, filename, mimeType: short(file.mimeType, 30), size: file.size };
      // Reserve room for an error/skip reason and the final summary before doing any work.
      const kind = preparationKind(file);
      const preparedFolder = `${path}.${kind === 'har' ? 'har' : 'extracted'}`;
      const reserved = { ...info,
        ...(isVideo(file) ? { frames: { directory: `${path}.frames-${'0'.repeat(64)}`, count: 24, sampled: true, reused: true,
          skipped: 'FFmpeg/ffprobe unavailable. Install both on the MCP host or set JIRA_FFMPEG_PATH and JIRA_FFPROBE_PATH.' } } : {}),
        ...(kind ? { preparation: { kind, directory: preparedFolder, index: join(preparedFolder, 'index.jsonl'), count: 20_000,
          reused: true, skippedEntries: 20_000, skipped: 'Attachment preparation or filesystem operation failed; original retained.' } } : {}) };
      if (tokens(rows.join('\n') + '\n' + serialize(reserved)) > 3650) break;
      processed++;
      if (file.size > this.config.maxFileBytes || file.size > remaining) {
        rows.push(serialize({ ...info, path: null, skipped: 'size exceeds file or remaining call limit' }));
        continue;
      }
      const tmp = join(folder, `.${file.id}-${randomUUID()}.part`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const controller = new AbortController();
      const cancel = () => controller.abort(new SafeError('Attachment operation cancelled.'));
      signal?.addEventListener('abort', cancel, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const stopTimers = () => { clearTimeout(timer); clearTimeout(idle); };
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new SafeError('Download idle timeout; partial file discarded.')), this.config.downloadIdleTimeoutMs);
      };
      const success = async (reused = false) => {
        let frames;
        let preparation;
        if (isVideo(file)) {
          if (this.config.videoFrames === false) frames = { skipped: 'Video frame extraction disabled by JIRA_VIDEO_FRAMES.' };
          else {
            try { frames = await this.frames.extract(path, videoBudget); }
            catch (error) { frames = { skipped: error instanceof SafeError ? short(error.message, 70) : 'Video frame extraction or filesystem operation failed.' }; }
          }
        }
        if (kind) {
          try { preparation = await this.prepareAttachment(file, path, kind, archiveBudget, signal); }
          catch (error) { preparation = { kind, skipped: error instanceof SafeError ? short(error.message, 70) : 'Attachment preparation or filesystem operation failed; original retained.' }; }
        }
        rows.push(serialize({ ...info, ...(reused ? { reused: true } : {}), ...(frames ? { frames } : {}), ...(preparation ? { preparation } : {}) }));
      };
      try {
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new SafeError('Destination is not a regular file.');
          if (stat.size === file.size) { await success(true); continue; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        timer = setTimeout(() => controller.abort(new SafeError('Download total timeout; partial file discarded.')), this.config.downloadTimeoutMs);
        resetIdle();
        const response = await client.download(file.id, controller.signal);
        reader = response.body?.getReader();
        if (!reader) throw new SafeError('Empty download response.');
        handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          resetIdle();
          size += value.byteLength;
          remaining -= value.byteLength;
          if (size > this.config.maxFileBytes || remaining < 0) throw new SafeError('Download exceeded file or call limit.');
          await handle.writeFile(value);
        }
        if (size !== file.size) throw new SafeError('Downloaded size differs from Jira metadata; partial file discarded.');
        stopTimers();
        await handle.close(); handle = undefined;
        if (await realpath(folder) !== resolve(folder)) throw new SafeError('Attachment directory changed during download.');
        await rename(tmp, path);
        await success();
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        rows.push(serialize({ ...info, path: null, skipped: reason instanceof SafeError ? short(reason.message, 60) : 'Download or filesystem operation failed; partial file discarded.' }));
      } finally {
        stopTimers();
        controller.abort();
        signal?.removeEventListener('abort', cancel);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        await handle?.close().catch(() => {});
        await unlink(tmp).catch(() => {});
      }
    }
    signal?.throwIfAborted();
    rows.push(serialize({ processed, total: files.length, ...(processed < files.length ? {
      remaining: files.length - processed, note: 'Output limit reached; remaining files not downloaded. Use get_issue to list IDs, then get_attachments ids.'
    } : {}) }));
    return rows.join('\n');
  }
}
