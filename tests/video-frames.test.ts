import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentStore } from '../src/attachments.js';
import { getAttachments } from '../src/tools/get-attachments.js';
import { tokens } from '../src/output.js';
import { frameBudget, isVideo, runMedia, VideoFrames, type MediaRunner } from '../src/video-frames.js';
import { config, mockClient, issue, json } from './helpers.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const metadata = (overrides = {}) => Buffer.from(JSON.stringify({ format: { duration: '120' }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', ...overrides },
] }));

async function withVideo(action: (path: string, folder: string) => Promise<void>) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'jira-video-')));
  const path = join(folder, '101-demo.mp4');
  try { await writeFile(path, 'video'); await action(path, folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test('video detection handles MIME types and common recording filenames', () => {
  const file = { id: '1', size: 1, filename: 'x.bin', mimeType: 'video/mp4' };
  assert.equal(isVideo(file), true);
  assert.equal(isVideo({ ...file, mimeType: 'application/octet-stream', filename: 'recording.MOV' }), true);
  assert.equal(isVideo({ ...file, mimeType: 'image/png', filename: 'screen.png' }), false);
});

test('uniform sampling publishes private JPEG files with a timestamp manifest and reuses them', async () => withVideo(async (path, folder) => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const runner: MediaRunner = async (executable, args, options) => {
    calls.push({ executable, args });
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 60_000);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(args[args.indexOf('-enable_drefs') + 1], '0');
    assert.equal(args[args.indexOf('-use_absolute_path') + 1], '0');
    assert.equal(args[args.indexOf('-i') + 1], path);
    assert.match(options.cwd, /\.video-frames-/);
    return executable.endsWith('ffprobe') ? metadata() : jpeg;
  };
  const frames = new VideoFrames({ ...config, ffmpegPath: '/trusted/ffmpeg' }, runner);
  const output = await frames.extract(path, frameBudget());
  assert.equal(output.count, 24);
  assert.equal(output.sampled, true);
  const manifest = JSON.parse(await readFile(join(output.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.frames.length, 24);
  assert.equal(manifest.frames[0].requestedTimeSeconds, 0);
  assert.ok(manifest.frames[23].requestedTimeSeconds > 119 && manifest.frames[23].requestedTimeSeconds < 120);
  for (const frame of manifest.frames) assert.deepEqual(await readFile(join(output.directory, frame.filename)), jpeg);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(output.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(output.directory, 'frame-001.jpg'))).mode & 0o777, 0o600);
  }
  assert.equal(calls.length, 25);
  assert.ok(calls.slice(1).every(c => c.args.at(-1) === 'pipe:1'));
  const cached = await frames.extract(path, frameBudget());
  assert.equal(cached.directory, output.directory);
  assert.equal(cached.reused, true);
  assert.equal(calls.length, 25);
  assert.ok((await readdir(folder)).every(name => !name.startsWith('.video-frames-')));
  await writeFile(path, 'other'); // Same size: cache identity must depend on contents.
  assert.notEqual((await frames.extract(path, frameBudget())).directory, output.directory);
}));

test('failed extraction keeps the downloaded video and removes temporary frames', async () => withVideo(async (_path, folder) => {
  const conf = { ...config, attachmentDir: join(folder, 'attachments') };
  let images = 0;
  const frames = new VideoFrames(conf, async executable => {
    if (executable === 'ffprobe') return metadata();
    if (images++) throw new Error('private diagnostic with test-secret-token');
    return jpeg;
  });
  const store = new AttachmentStore(conf, frames);
  const file = { id: '1', filename: 'recording.mp4', mimeType: 'video/mp4', size: 5 };
  const text = await store.download(mockClient(() => new Response('video')), 'DEMO-1', [file]);
  const row = JSON.parse(text.split('\n')[0]!);
  assert.equal(await readFile(row.path, 'utf8'), 'video');
  assert.equal(row.skipped, undefined);
  assert.match(row.frames.skipped, /extraction/);
  assert.doesNotMatch(text, /private diagnostic|test-secret-token/);
  assert.deepEqual(await readdir(join(conf.attachmentDir, conf.sessionId, 'DEMO-1')), ['1-recording.mp4']);
}));

test('video frames also appear when an existing download is reused; disabled mode starts no decoder', async () => withVideo(async (_path, folder) => {
  const conf = { ...config, attachmentDir: join(folder, 'attachments') };
  let calls = 0, downloads = 0;
  const frames = new VideoFrames(conf, async executable => { calls++; return executable === 'ffprobe' ? metadata() : jpeg; });
  const file = { id: '1', filename: 'recording.mp4', mimeType: 'video/mp4', size: 5 };
  const client = mockClient(() => { downloads++; return new Response('video'); });
  const store = new AttachmentStore(conf, frames);
  const first = JSON.parse((await store.download(client, 'DEMO-1', [file])).split('\n')[0]!);
  const second = JSON.parse((await store.download(client, 'DEMO-1', [file])).split('\n')[0]!);
  assert.equal(downloads, 1);
  assert.equal(calls, 25);
  assert.equal(second.reused, true);
  assert.equal(second.frames.reused, true);
  assert.equal(first.frames.directory, second.frames.directory);
  const disabled = new AttachmentStore({ ...conf, videoFrames: false }, frames);
  const result = JSON.parse((await disabled.download(client, 'DEMO-1', [file])).split('\n')[0]!);
  assert.match(result.frames.skipped, /disabled/);
  assert.equal(calls, 25);
}));

test('two server processes sharing a session can safely publish the same frames', async () => withVideo(async (path, folder) => {
  const runner: MediaRunner = async executable => {
    if (executable === 'ffprobe') {
      await new Promise(resolve => setTimeout(resolve, 20));
      return metadata({ duration: '1' });
    }
    return jpeg;
  };
  const [a, b] = await Promise.all([
    new VideoFrames(config, runner).extract(path, frameBudget()),
    new VideoFrames(config, runner).extract(path, frameBudget()),
  ]);
  assert.equal(a.directory, b.directory);
  assert.ok(a.reused || b.reused);
  assert.ok((await readdir(folder)).every(name => !name.startsWith('.video-frames-')));
}));

test('video frame metadata fits the attachment output limit; undisclosed files are not processed', async () => withVideo(async (_path, folder) => {
  const conf = { ...config, attachmentDir: join(folder, 'attachments') };
  const frames = new VideoFrames(conf, async executable => executable === 'ffprobe' ? metadata({ duration: '1' }) : jpeg);
  const files = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), filename: 'recording.mp4', mimeType: 'video/mp4', size: 5 }));
  let downloads = 0;
  const store = new AttachmentStore(conf, frames);
  const output = await store.download(mockClient(() => { downloads++; return new Response('video'); }), 'DEMO-1', files);
  const rows = output.split('\n').map(line => JSON.parse(line));
  const summary = rows.pop();
  assert.ok(tokens(output) <= 4000);
  assert.ok(summary.processed < summary.total);
  assert.equal(summary.processed, downloads);
  assert.equal(summary.processed, rows.length);
  assert.ok(rows.every(row => row.frames.count === 1));
  assert.equal((await readdir(join(conf.attachmentDir, conf.sessionId, 'DEMO-1'))).length, downloads * 2);
}));

test('unsafe input, cached directory, cached frame and manifest paths are refused', async () => withVideo(async (path, folder) => {
  const frames = new VideoFrames(config, async executable => executable === 'ffprobe' ? metadata() : jpeg);
  const outside = join(folder, 'outside');
  await writeFile(outside, 'safe');
  const link = join(folder, 'symlink.mp4');
  await symlink(outside, link);
  await assert.rejects(frames.extract(link, frameBudget()), /Unsafe/);
  const output = await frames.extract(path, frameBudget());
  const frame = join(output.directory, 'frame-001.jpg');
  await rm(frame);
  await symlink(outside, frame);
  await assert.rejects(frames.extract(path, frameBudget()), /Unsafe/);
  await rm(frame);
  await writeFile(frame, jpeg);
  const manifestPath = join(output.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.frames[0].filename = '../outside';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(frames.extract(path, frameBudget()), /invalid/);
  await rm(manifestPath);
  await symlink(outside, manifestPath);
  await assert.rejects(frames.extract(path, frameBudget()), /Unsafe/);
  await rm(output.directory, { recursive: true });
  await symlink(folder, output.directory);
  await assert.rejects(frames.extract(path, frameBudget()), /Unsafe/);
  assert.equal(await readFile(outside, 'utf8'), 'safe');
}));

test('invalid probe data, dimensions, duration and frame output fail without publishing a folder', async () => {
  for (const [probe, image] of [
    [metadata({ width: 90000 }), jpeg], [metadata({ duration: 'NaN' }), jpeg],
    [metadata({ duration: '100000' }), jpeg], [metadata({ codec_name: 'unknown' }), jpeg],
    [Buffer.from('invalid JSON'), jpeg], [metadata(), Buffer.from('not JPEG')],
  ]) await withVideo(async (path, folder) => {
    const frames = new VideoFrames(config, async executable => executable === 'ffprobe' ? probe! : image!);
    await assert.rejects(frames.extract(path, frameBudget()));
    assert.deepEqual(await readdir(folder), ['101-demo.mp4']);
  });
});

test('frame byte and time budgets cover all videos in one call, including reused frames', async () => withVideo(async (path, folder) => {
  const frames = new VideoFrames(config, async executable => executable === 'ffprobe' ? metadata({ duration: '1' }) : jpeg);
  const budget = { remainingBytes: 4, remainingMs: 60000 };
  await frames.extract(path, budget);
  assert.equal(budget.remainingBytes, 0);
  const other = join(folder, '102-other.mp4');
  await writeFile(other, 'other');
  await assert.rejects(frames.extract(other, budget), /size limit/);
  await assert.rejects(frames.extract(path, { remainingBytes: 3, remainingMs: 60000 }), /size limit/);
  await assert.rejects(frames.extract(path, { remainingBytes: 1000, remainingMs: 0 }), /time limit/);
}));

test('decoder processes receive no credentials and cannot use shell arguments', async () => withVideo(async (_path, folder) => {
  const secret = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = 'must-not-reach-child';
  try {
    const output = await runMedia(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret:process.env.JIRA_API_TOKEN,args:process.argv.slice(1)}))', '$(touch shell-injection)'], { cwd: folder, timeoutMs: 2000, maxOutputBytes: 1000 });
    const result = JSON.parse(output.toString());
    assert.equal(result.secret, undefined);
    assert.deepEqual(result.args, ['$(touch shell-injection)']);
    assert.deepEqual(await readdir(folder), ['101-demo.mp4']);
  } finally { if (secret === undefined) delete process.env.JIRA_API_TOKEN; else process.env.JIRA_API_TOKEN = secret; }
}));

test('decoder failures, missing executables, timeouts and output overflow are bounded and redact diagnostics', async () => withVideo(async (_path, folder) => {
  const options = { cwd: folder, timeoutMs: 150, maxOutputBytes: 100 };
  await assert.rejects(runMedia(join(folder, 'missing'), [], options), /FFmpeg\/ffprobe unavailable/);
  await assert.rejects(runMedia(process.execPath, ['-e', 'process.stderr.write("private-secret");process.exit(1)'], options), error => error instanceof Error && !error.message.includes('private-secret'));
  await assert.rejects(runMedia(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], options), /time limit/);
  await assert.rejects(runMedia(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000))'], options), /size limit/);
  await assert.rejects(runMedia(process.execPath, ['-e', 'process.stderr.write("a".repeat(100000))'], options), /diagnostic limit/);
}));

test('real FFmpeg extracts scaled frames across a video and refuses playlist input', async t => withVideo(async (_path, folder) => {
  const exec = promisify(execFile);
  try { await exec('ffmpeg', ['-version']); await exec('ffprobe', ['-version']); }
  catch { t.skip('FFmpeg and ffprobe are not installed on this test host.'); return; }
  const path = join(folder, 'real.mp4');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=10:duration=3', '-c:v', 'mpeg4', '-threads', '1', '-y', path]);
  const frames = new VideoFrames(config);
  const video = await readFile(path);
  const file = { id: '101', filename: 'real.mp4', mimeType: 'video/mp4', size: video.length };
  const conf = { ...config, readOnly: true, attachmentDir: join(folder, 'attachments') };
  const client = mockClient(url => url.pathname.endsWith('/issue/DEMO-8901')
    ? json({ ...issue, fields: { attachment: [file] } }) : new Response(video), conf);
  const result = await getAttachments(client, new AttachmentStore(conf), { key: 'DEMO-8901', ids: ['101'] });
  const row = JSON.parse(result.split('\n')[0]!);
  assert.deepEqual(await readFile(row.path), video);
  const output = row.frames;
  assert.equal(output.count, 3);
  const manifest = JSON.parse(await readFile(join(output.directory, 'manifest.json'), 'utf8'));
  assert.ok(manifest.frames[2].requestedTimeSeconds >= 2.8);
  for (const frame of manifest.frames) {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', join(output.directory, frame.filename)]);
    const { width, height } = JSON.parse(stdout).streams[0];
    assert.equal(width, 1280);
    assert.ok(height <= 1280);
  }
  const playlist = join(folder, 'playlist.mp4');
  await writeFile(playlist, `ffconcat version 1.0\nfile '${path}'\n`);
  await assert.rejects(frames.extract(playlist, frameBudget()), /unsupported|damaged/);
  assert.ok((await readdir(folder)).every(name => !name.startsWith('.video-frames-')));
}));
