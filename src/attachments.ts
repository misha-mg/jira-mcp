import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Attachment } from './jira/types.js';
import type { JiraClient } from './jira/client.js';
import { SafeError } from './jira/errors.js';
import { serialize, short, tokens } from './output.js';

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
  constructor(private config: Config) {}

  async prepare() {
    try { await directory(this.config.attachmentDir); await access(this.config.attachmentDir, constants.W_OK); }
    catch (e) { if (e instanceof SafeError) throw e; throw new SafeError('JIRA_ATTACHMENT_DIR cannot be created or accessed.'); }
  }

  download(client: JiraClient, key: string, files: Attachment[]): Promise<string> {
    // Serialise shared-directory operations in this server; atomic renames also protect readers.
    const task = this.pending.then(() => this.run(client, key, files));
    this.pending = task.catch(() => {});
    return task;
  }

  private async run(client: JiraClient, key: string, files: Attachment[]): Promise<string> {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new SafeError('Invalid issue key.');
    await this.prepare();
    const root = await realpath(this.config.attachmentDir);
    const session = join(root, this.config.sessionId);
    await directory(session);
    const folder = join(session, key);
    await directory(folder);
    if (await realpath(folder) !== resolve(folder)) throw new SafeError('Unsafe attachment directory.');
    let remaining = this.config.maxCallBytes;
    const rows: string[] = [];
    let processed = 0;
    for (const file of files) {
      if (!/^\d+$/.test(file.id) || !Number.isSafeInteger(file.size) || file.size < 0) throw new SafeError('Jira returned invalid attachment metadata.');
      const filename = `${file.id}-${safeFilename(file.filename)}`;
      const path = join(folder, filename);
      const info = { id: file.id, path, filename, mimeType: short(file.mimeType, 30), size: file.size };
      // Reserve room for an error/skip reason and the final summary before doing any work.
      if (tokens(rows.join('\n') + '\n' + serialize(info)) > 3650) break;
      processed++;
      if (file.size > this.config.maxFileBytes || file.size > remaining) {
        rows.push(serialize({ ...info, path: null, skipped: 'size exceeds file or remaining call limit' }));
        continue;
      }
      const tmp = join(folder, `.${file.id}-${randomUUID()}.part`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new SafeError('Destination is not a regular file.');
          if (stat.size === file.size) { rows.push(serialize({ ...info, reused: true })); continue; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const response = await client.download(file.id);
        reader = response.body?.getReader();
        if (!reader) throw new SafeError('Empty download response.');
        handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          remaining -= value.byteLength;
          if (size > this.config.maxFileBytes || remaining < 0) throw new SafeError('Download exceeded file or call limit.');
          await handle.writeFile(value);
        }
        if (size !== file.size) throw new SafeError('Downloaded size differs from Jira metadata; partial file discarded.');
        await handle.close(); handle = undefined;
        if (await realpath(folder) !== resolve(folder)) throw new SafeError('Attachment directory changed during download.');
        await rename(tmp, path);
        rows.push(serialize(info));
      } catch (error) {
        rows.push(serialize({ ...info, path: null, skipped: error instanceof SafeError ? short(error.message, 60) : 'Download or filesystem operation failed; partial file discarded.' }));
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
        await handle?.close().catch(() => {});
        await unlink(tmp).catch(() => {});
      }
    }
    rows.push(serialize({ processed, total: files.length, ...(processed < files.length ? {
      remaining: files.length - processed, note: 'Output limit reached; remaining files not downloaded. Use get_issue to list IDs, then get_attachments ids.'
    } : {}) }));
    return rows.join('\n');
  }
}
