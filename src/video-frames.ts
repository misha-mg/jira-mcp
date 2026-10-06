import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Config } from './config.js';
import type { Attachment } from './jira/types.js';
import { SafeError } from './jira/errors.js';

const MAX_FRAMES = 24;
const MAX_DIMENSION = 1280;
const MAX_IMAGE_BYTES = 1_000_000;
const MAX_VIDEO_BYTES = 10_000_000;
const MAX_PROBE_BYTES = 64_000;
const INPUT_OPTIONS = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi',
  '-enable_drefs', '0', '-use_absolute_path', '0', '-max_streams', '16', '-probesize', '1048576', '-analyzeduration', '3000000'];
const COMMON_OPTIONS = ['-hide_banner', '-loglevel', 'error', '-max_alloc', '67108864'];
const CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mjpeg']);

export interface FrameBudget { remainingBytes: number; remainingMs: number }
export const frameBudget = (): FrameBudget => ({ remainingBytes: 20_000_000, remainingMs: 60_000 });
export interface Frames { directory: string; count: number; sampled: true; reused?: true }
interface Frame { filename: string; requestedTimeSeconds: number; size: number }
interface Manifest { version: 1; sourceSha256: string; durationSeconds: number; maxDimension: number; sampled: true; frames: Frame[] }
interface RunOptions { cwd: string; timeoutMs: number; maxOutputBytes: number }
export type MediaRunner = (executable: string, args: string[], options: RunOptions) => Promise<Buffer>;

export function isVideo(file: Attachment): boolean {
  return /^video\//i.test(file.mimeType) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.filename);
}

// No shell, no Jira credentials in the child environment, no unbounded output.
// SIGKILL and close ensure no decoder is left writing after a failed operation.
export const runMedia: MediaRunner = (executable, args, options) => new Promise((resolveOutput, reject) => {
  if (options.timeoutMs <= 0) { reject(new SafeError('Video frame extraction time limit reached.')); return; }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const child = spawn(executable, args, { shell: false, windowsHide: true, cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let bytes = 0, errorBytes = 0;
  let failure: SafeError | undefined;
  const stop = (message: string) => { failure ??= new SafeError(message); child.kill('SIGKILL'); };
  const timer = setTimeout(() => stop('Video frame extraction time limit reached.'), options.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxOutputBytes) stop('Video frame output size limit reached.');
    else chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > MAX_PROBE_BYTES) stop('Video decoder diagnostic limit reached.');
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    failure ??= new SafeError(error.code === 'ENOENT' || error.code === 'EACCES'
      ? 'FFmpeg/ffprobe unavailable. Install both on the MCP host or set JIRA_FFMPEG_PATH and JIRA_FFPROBE_PATH.'
      : 'Video decoder could not start.');
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else if (code !== 0) reject(new SafeError('Video is unsupported, damaged, or could not be decoded safely.'));
    else resolveOutput(Buffer.concat(chunks));
  });
});

async function regularFile(path: string, maxBytes: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new SafeError('Unsafe video or frame file.');
  return stat;
}

async function readSmall(path: string, maxBytes: number): Promise<Buffer> {
  await regularFile(path, maxBytes);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new SafeError('Video frame output size limit reached.');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

async function sourceHash(path: string, maxBytes: number, deadline: number) {
  await regularFile(path, maxBytes);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      if (performance.now() >= deadline) throw new SafeError('Video frame extraction time limit reached.');
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return hash.digest('hex');
      total += bytesRead;
      if (total > maxBytes) throw new SafeError('Video input size limit reached.');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

async function writePrivate(path: string, contents: Buffer | string) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents); }
  finally { await handle.close(); }
}

function videoInfo(data: Buffer) {
  const probe = JSON.parse(data.toString('utf8'));
  const stream = probe.streams?.find((s: { codec_type?: string; disposition?: { attached_pic?: number } }) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(stream?.duration ?? probe.format?.duration);
  if (!stream || !CODECS.has(stream.codec_name) || !Number.isFinite(duration) || duration <= 0 || duration > 86_400 ||
      !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width <= 0 || stream.height <= 0 ||
      stream.width > 8192 || stream.height > 8192 || stream.width * stream.height > 8_847_360 || !Number.isSafeInteger(stream.index) || stream.index < 0) {
    throw new SafeError('Video codec, duration, or dimensions are unsupported or exceed safety limits.');
  }
  const rate = String(stream.avg_frame_rate ?? '').match(/^(\d+)\/(\d+)$/);
  const fps = rate ? Number(rate[1]) / Number(rate[2]) : NaN;
  // Leave one source frame at the end so seeking does not run past the last frame.
  const end = Math.max(0, duration - Math.max(0.1, Number.isFinite(fps) && fps > 0 ? 1 / fps : 1));
  return { duration, index: stream.index as number, end, count: Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration))) };
}

async function cachedFrames(directory: string, hash: string, deadline: number): Promise<{ result: Frames; bytes: number }> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SafeError('Unsafe cached video frame directory.');
  let manifest: Manifest;
  try { manifest = JSON.parse((await readSmall(join(directory, 'manifest.json'), MAX_PROBE_BYTES)).toString('utf8')) as Manifest; }
  catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('Cached video frames are incomplete or invalid.');
  }
  if (manifest?.version !== 1 || manifest.sourceSha256 !== hash || manifest.maxDimension !== MAX_DIMENSION || manifest.sampled !== true ||
      !Number.isFinite(manifest.durationSeconds) || manifest.durationSeconds <= 0 || manifest.durationSeconds > 86_400 || !Array.isArray(manifest.frames) ||
      !manifest.frames.length || manifest.frames.length > MAX_FRAMES) throw new SafeError('Cached video frames are incomplete or invalid.');
  const entries = await readdir(directory);
  if (entries.length !== manifest.frames.length + 1) throw new SafeError('Cached video frames are incomplete or invalid.');
  let bytes = 0;
  for (const [i, frame] of manifest.frames.entries()) {
    if (performance.now() >= deadline) throw new SafeError('Video frame extraction time limit reached.');
    if (!frame || frame.filename !== `frame-${String(i + 1).padStart(3, '0')}.jpg` || !Number.isFinite(frame.requestedTimeSeconds) ||
        frame.requestedTimeSeconds < 0 || frame.requestedTimeSeconds >= manifest.durationSeconds || !Number.isSafeInteger(frame.size) || frame.size <= 0) {
      throw new SafeError('Cached video frames are incomplete or invalid.');
    }
    try {
      const stat = await regularFile(join(directory, frame.filename), MAX_IMAGE_BYTES);
      if (stat.size !== frame.size) throw new SafeError('Cached video frames are incomplete or invalid.');
      bytes += stat.size;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError('Cached video frames are incomplete or invalid.');
    }
  }
  if (bytes > MAX_VIDEO_BYTES) throw new SafeError('Video frame output size limit reached.');
  return { result: { directory, count: manifest.frames.length, sampled: true, reused: true }, bytes };
}

export class VideoFrames {
  constructor(private config: Config, private run: MediaRunner = runMedia) {}

  async extract(path: string, budget: FrameBudget): Promise<Frames> {
    const start = performance.now();
    const deadline = start + budget.remainingMs;
    let staging: string | undefined;
    try {
      if (budget.remainingMs <= 0) throw new SafeError('Video frame extraction time limit reached.');
      if (budget.remainingBytes <= 0) throw new SafeError('Video frame output size limit reached.');
      const parent = dirname(path);
      if (await realpath(parent) !== resolve(parent)) throw new SafeError('Unsafe video frame directory.');
      const hash = await sourceHash(path, this.config.maxFileBytes, deadline);
      // Content-addressed paths prevent stale previews when a source file changes.
      const directory = `${path}.frames-${hash}`;
      try {
        const cached = await cachedFrames(directory, hash, deadline);
        if (cached.bytes > budget.remainingBytes) throw new SafeError('Video frame output size limit reached.');
        budget.remainingBytes -= cached.bytes;
        return cached.result;
      } catch (error) {
        // Only an absent directory is a cache miss. Never traverse or overwrite unsafe cache entries.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      staging = await mkdtemp(join(parent, '.video-frames-'));
      await chmod(staging, 0o700);
      const run = (executable: string, args: string[], maxOutputBytes: number) => this.run(executable, args, {
        cwd: staging!, timeoutMs: Math.max(0, Math.floor(deadline - performance.now())), maxOutputBytes,
      });
      const ffmpeg = this.config.ffmpegPath ?? 'ffmpeg';
      const ffprobe = this.config.ffprobePath ?? (this.config.ffmpegPath ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
      const info = videoInfo(await run(ffprobe, [...COMMON_OPTIONS, ...INPUT_OPTIONS, '-show_entries',
        'format=duration:stream=index,codec_type,codec_name,width,height,duration,avg_frame_rate:stream_disposition=attached_pic', '-of', 'json', '-i', path], MAX_PROBE_BYTES));
      const frames: Frame[] = [];
      let bytes = 0;
      for (let i = 0; i < info.count; i++) {
        const time = Number((info.count === 1 ? 0 : info.end * i / (info.count - 1)).toFixed(6));
        const allowance = Math.min(MAX_IMAGE_BYTES, MAX_VIDEO_BYTES - bytes, budget.remainingBytes);
        if (allowance <= 0) throw new SafeError('Video frame output size limit reached.');
        // Reserve output before running. A failed/overflowing decoder still consumes its allowance.
        budget.remainingBytes -= allowance;
        const image = await run(ffmpeg, [...COMMON_OPTIONS, '-nostdin', '-threads', '1', '-filter_threads', '1',
          ...INPUT_OPTIONS, '-ss', String(time), '-i', path, '-map', `0:${info.index}`, '-an', '-sn', '-dn',
          '-frames:v', '1', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1",
          '-c:v', 'mjpeg', '-threads', '1', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'], allowance);
        if (image.length > allowance) throw new SafeError('Video frame output size limit reached.');
        budget.remainingBytes += allowance - image.length;
        bytes += image.length;
        if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
          throw new SafeError('Video decoder did not produce a complete JPEG frame.');
        }
        const filename = `frame-${String(i + 1).padStart(3, '0')}.jpg`;
        await writePrivate(join(staging, filename), image);
        frames.push({ filename, requestedTimeSeconds: time, size: image.length });
      }
      const manifest: Manifest = { version: 1, sourceSha256: hash, durationSeconds: info.duration, maxDimension: MAX_DIMENSION, sampled: true, frames };
      await writePrivate(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
      if (await sourceHash(path, this.config.maxFileBytes, deadline) !== hash || await realpath(parent) !== resolve(parent)) {
        throw new SafeError('Video or attachment directory changed during frame extraction.');
      }
      try { await rename(staging, directory); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // Another server sharing this session may have published the same cache first.
        const cached = await cachedFrames(directory, hash, deadline);
        if (cached.bytes > bytes) {
          if (cached.bytes - bytes > budget.remainingBytes) throw new SafeError('Video frame output size limit reached.');
          budget.remainingBytes -= cached.bytes - bytes;
        }
        return cached.result;
      }
      staging = undefined;
      return { directory, count: frames.length, sampled: true };
    } finally {
      budget.remainingMs = Math.max(0, budget.remainingMs - (performance.now() - start));
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
