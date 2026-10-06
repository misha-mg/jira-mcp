# Jira MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for Jira Cloud. Read and search issues, download attachments to real files, add comments, and transition issues.

Runs over **stdio** on Node.js 22 or later, using the official MCP TypeScript SDK. Designed for Claude Code, its subagents, and Claude Desktop.

## Connect through npm

Package: [`@misha_m.g/jira-mcp`](https://www.npmjs.com/package/@misha_m.g/jira-mcp).

Release status: `0.1.3` is prepared for the next release and is not published yet. Until publication, run a source checkout or a locally packed archive as described below. See [CHANGELOG.md](CHANGELOG.md) for the planned changes.

Create an env file using [`.env.example`](.env.example), fill in your Jira credentials, and add the following to your MCP client configuration:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": [
        "-y",
        "@misha_m.g/jira-mcp@0.1.3",
        "--env-file",
        "/absolute/path/to/your/project/.env"
      ]
    }
  }
}
```

The client downloads the package and runs it locally. Node.js 22+ and npm must be available on the machine. Pinning the version makes updates explicit.

## Run from source

```sh
git clone https://github.com/misha-mg/jira-mcp.git
cd jira-mcp
npm ci
npm run build
cp .env.example .env
```

Fill in `.env`, then configure your MCP client:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": [
        "/absolute/path/to/jira-mcp/dist/index.js",
        "--env-file",
        "/absolute/path/to/your/project/.env"
      ]
    }
  }
}
```

Use absolute paths. If your desktop app cannot find Node.js, use the absolute path to the Node executable as `command`.

The client starts the server automatically. A manually started server waits for MCP messages on stdin; stdout is reserved for the protocol and diagnostics go to stderr.

## Configuration

Create a **scoped API token for Jira** at [Atlassian account settings](https://id.atlassian.com/manage-profile/security/api-tokens). The implemented endpoints require these classic scopes:

- `read:jira-work` for reading, searching, downloading attachments, and workflow metadata.
- `write:jira-work` additionally for comments and transitions.

The token owner's Jira permissions still apply. The server uses HTTP Basic authentication against `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`.

| Variable | Required | Default / purpose |
|---|---|---|
| `JIRA_BASE_URL` | Yes | Site origin, e.g. `https://company.atlassian.net` |
| `JIRA_EMAIL` | Yes | Token owner's email |
| `JIRA_API_TOKEN` | Yes | Jira scoped API token |
| `JIRA_ATTACHMENT_DIR` | No | `$XDG_CACHE_HOME/jira-mcp` when XDG_CACHE_HOME is absolute; otherwise `~/.cache/jira-mcp` |
| `JIRA_CLOUD_ID` | No | Discovered using the site's public `/_edge/tenant_info` endpoint when omitted |
| `JIRA_READ_ONLY` | No | `false`; set `true` to expose only read tools. The example env file uses `true` |
| `JIRA_SESSION_ID` | No | New UUID per process; set explicitly to share a session directory between processes |
| `JIRA_MAX_FILE_BYTES` | No | `536870912` (512 MiB) per file |
| `JIRA_MAX_CALL_BYTES` | No | `1073741824` (1 GiB) downloaded per call |
| `JIRA_TIMEOUT_MS` | No | `30000` per ordinary Jira API request, including body consumption |
| `JIRA_DOWNLOAD_TIMEOUT_MS` | No | `600000` (10 minutes) per file, including HTTP body consumption |
| `JIRA_DOWNLOAD_IDLE_TIMEOUT_MS` | No | `30000` (30 seconds) waiting for headers or more download data |
| `JIRA_MAX_EXTRACTED_BYTES` | No | `1073741824` (1 GiB) actual expanded TAR stream bytes per call, including skipped data, metadata and padding |
| `JIRA_MAX_ARCHIVE_ENTRIES` | No | `20000` entries per TAR.GZ archive |
| `JIRA_VIDEO_FRAMES` | No | `true`; set `false` to download videos without extracting frame previews |
| `JIRA_FFMPEG_PATH` | No | Absolute path to the host's FFmpeg executable; otherwise `ffmpeg` on `PATH` |
| `JIRA_FFPROBE_PATH` | No | Absolute path to ffprobe; defaults to the executable beside an explicit `JIRA_FFMPEG_PATH`, otherwise `ffprobe` on `PATH` |

The server loads an env file **only** when `--env-file` is supplied. Process environment variables override file values. Relative attachment paths resolve against the env file's directory, or the process working directory without an env file. `${VAR}` interpolation inside values is not supported.

Credentials and downloads are excluded from Git and npm packaging. Missing or invalid configuration does not interrupt the MCP handshake or tool listing: tool calls return an explicit configuration error. Fix the environment or env file and restart the MCP server to reload it. Read-only mode still controls tool registration; if the env file cannot be read or the read-only setting is invalid, only read tools are exposed. Authentication and permission errors also surface when calling Jira. Tokens and raw Jira error bodies are not returned in tool errors.

## Tools

| Tool | Inputs | Result |
|---|---|---|
| `get_issue` | `key`, optional `comments` (default `false`) | Full projected issue as JSON; all accessible comments when requested |
| `search_issues` | `jql`, optional `limit` (default 10, maximum 50) | One JSON line per issue, followed by `shown` and `has_more` |
| `get_attachments` | `key`, optional `ids` (up to 100) | Downloaded paths and metadata; HAR/TAR.GZ include preparation directory/index; videos include sampled JPEG frames; failures include skip reasons |
| `add_comment` | `key`, `body` | Comment ID and confirmation |
| `transition_issue` | `key`, `to`, optional `resolution`, `comment` | Target status and confirmation |

`get_issue` returns `key`, `summary`, `status`, `type`, `priority`, `labels`, `fixVersions`, `description`, and an attachment index containing `id`, `filename`, `mimeType`, and `size`. With `comments=true`, it also returns `comments` (`author`, `created`, `body`) and `comments_total`.

Descriptions and comments are converted from Atlassian Document Format to plain text. Service URLs, avatar objects, and unrelated Jira fields are excluded. **Issue descriptions, comments, metadata, and complete issue responses are not shortened or token-capped by the server.**

Media in descriptions and comments retain their labels, e.g. `[attachment: screenshot.png]`, using Jira attachment metadata when the ID matches or the ADF node's `alt` text otherwise. ADF usually uses a separate Media Services ID. If no name is supplied, the placeholder explicitly says `filename unavailable` and includes that media ID when available; files are never guessed by array position. The original attachment index remains available.

When comments are requested, the server retrieves all Jira pages internally, oldest first. A failed page, invalid pagination, or changed comment count produces an error instead of a partial successful result. Jira does not provide a snapshot across requests; concurrent edits without count changes can still occur.

Search returns only `key`, `summary`, `status`, `type`, and `updated`, without shortening those fields or applying a token budget. It returns up to the requested number of issues supplied by Jira. When `has_more=true`, narrow the JQL; the tool does not expose search pagination or calculate an exact total.

Comments are **plain text**: Markdown is posted literally. `transition_issue.to` refers to the target **status name**, which can differ from the transition name. Resolution accepts a name or ID validated against available values. Unsupported required fields and ambiguous transitions produce explanatory errors. An optional transition comment is included in the same Jira request.

### Read-only mode

With `JIRA_READ_ONLY=true`, only `get_issue`, `search_issues`, and `get_attachments` are registered. Write tools are absent from `tools/list`, cannot be called directly, and POST requests are additionally blocked by the Jira client. Local attachment downloads remain available.

Write requests are never automatically retried. After a network failure, their outcome may be uncertain; check Jira before retrying.

## Attachments and sessions

Without an override, downloads use the user's cache directory, independent of the checkout/worktree. Remove `JIRA_ATTACHMENT_DIR` from project MCP configurations to use this default and allow inherited environment overrides. The directory is created only when downloading; an inaccessible directory produces a tool error and does not prevent issue reads or MCP startup. The client must be allowed to read this directory outside the repository.

Files are stored under:

```text
<attachment directory>/
  <session ID>/
    DEMO-123/
      101-screenshot.png
      102-recording.mp4
```

Attachment contents are never returned as base64, inline media, or embedded resources. The client must have its own local file-reading tool with access to the configured directory. Claude Desktop needs a suitable filesystem/image-reading integration; a returned path alone does not grant file access.

Filenames are sanitized and prefixed with the attachment ID. Repeated calls use stable paths; an existing regular file of the same size is reused without a checksum comparison. Downloads use temporary files and atomic renames. Partial files are removed, and byte limits are enforced against the actual stream. HAR and TAR.GZ are prepared as described below. Extracted archive members are saved as-is and never run through other processors. Files are never executed.

The base directory, session directory, issue directory, and existing destination must not be symlinks. Use a directory controlled by the account running the server; the server is not designed for a directory tree concurrently modified by an untrusted local user.

A generated session ID identifies a **server process**, not a Claude conversation. Subagents sharing the server share its files. Set the same `JIRA_SESSION_ID` for multiple processes that should share a directory, and change it for a new session. Old sessions are not deleted automatically.

The attachment response currently has a 4,000-token reference budget. If more entries would exceed it, remaining files are not downloaded and the response reports this. Read their IDs with `get_issue`, then call `get_attachments` with selected IDs. Paths are never shortened.

HTTP redirects are refused; attachment requests use `redirect=false` so credentials cannot be forwarded to another host. A site returning a redirect despite that flag produces an explicit error.

### HAR and TAR.GZ preparation

HAR and TAR.GZ preparation is included in version `0.1.3`. `get_attachments` automatically prepares files ending in `.har`, `.tar.gz`, or `.tgz`, without new tools or input parameters. Other formats retain their original files; video previews keep their existing behavior.

A successful attachment line adds a compact reference:

```json
{
  "preparation": {
    "kind": "har",
    "directory": "/absolute/cache/session/DEMO-123/101-network.har.har",
    "index": "/absolute/cache/session/DEMO-123/101-network.har.har/index.jsonl",
    "count": 42
  }
}
```

Read `index.jsonl` first, search it with Grep, then read the selected body or extracted file with Read's `offset` and `limit`. Contents are not embedded in MCP responses. Both kinds use a private completion marker keyed by attachment ID and original size. Only completed results are reused, with `preparation.reused=true`. Incomplete directories are regenerated. A processing error or MCP cancellation stops streams and removes partial preparation output, retaining a completed original download. The result reports `preparation.skipped` when preparation fails. An unsafe cache directory or symlink is refused; remove it from your controlled cache to retry. The cache does not detect content replacement with the same ID/size. Use one writer per issue/session directory while preparing new results; publication of these folders is not atomic across processes.

HAR layout:

```text
101-network.har
101-network.har.har/
  .complete.json
  index.jsonl
  entries/
    0001.request.txt
    0001.response.txt
    0042.request.txt
    0042.response.txt
```

The index has one line per `log.entries` object in source order, numbered from 1 (at least four filename digits). Bodies exist only when the corresponding HAR `text` string exists. Fields include `entry`, `startedDateTime`, `timeMs`, HTTP `method`, `url` without query values/userinfo/fragment, `status`, `rpcMethod`, `path`, `th`, `params.method`, `error`, `errorText`, original UTF-8 `requestBytes`/`responseBytes`, and relative `requestBody`/`responseBody` paths. Scalar previews are limited to 1,024 UTF-16 code units; `truncatedFields` identifies shortened values. Full text remains available in the body and original HAR. Missing fields are omitted.

JSON-RPC methods are read from the request body, falling back to `/jsonrpc/<method>`. Parameter previews use `params.path`, `params.th`, and `params.method` (with top-level `path`/`th` also recognized). Response checks inspect every element of a batch. `error=true` means a non-null RPC error was found, even with HTTP 200; `errorText` contains a bounded preview of `error.message` and scalar values under `error.data`. `error=false` requires a parsed, recognizable response with a string, finite number or null ID and a result, with no error. Legacy ConfD responses without `jsonrpc` are accepted; an explicit `jsonrpc` must be the string `"2.0"`. Invalid IDs/versions remain unknown. Discarded error-data values are marked in `truncatedFields` even when the preceding message exactly fills the preview limit. Missing bodies, malformed/non-RPC responses and unrecognized batch elements use `error=null` with `errorReason`. A batch with a known error and unrecognized elements still reports the known error and the incomplete check reason. Encoded bodies, including base64, retain their encoding and use `error=null`: this implementation does not automatically decode them.

The [stream-json parser](https://github.com/uhop/stream-json) never assembles an entire HAR, entry, key, or body string. `_initiator` and unrelated fields are discarded while parsing. Body files are streamed to disk, checked for RPC fields in a bounded-memory second pass, then prepared for line-based reading inside `har.ts`. JSON-looking bodies get structural newlines; any remaining long line, including huge string values such as `get_schema`, is wrapped at 2,000 UTF-16 code units. `requestView`/`responseView` report `formatted`, `lineWrapped`, `representation`, and `storedBytes`. A `readable-text-view` can contain newlines inside a JSON string and is **not valid JSON or a byte-for-byte body copy**; use the original HAR when exact serialization matters. No shared text-chunk processor or additional summary is created. JSON nesting deeper than 128 levels is refused.

TAR.GZ layout:

```text
102-diagnostics.tar.gz
102-diagnostics.tar.gz.extracted/
  .complete.json
  index.jsonl
  files/var/log/system.log
  files/var/debug/confd/running_config.xml
```

The index records each effective library-resolved `path`, actual `size`, entry `type`, `classification` (`text`, `binary`, or `unknown`), and a relative `extractedPath` or `skipped` reason. Classification uses up to 8 KiB of data and is only a hint. Empty files and non-file entries are `unknown`. Paths longer than 4,096 code units are refused and their index preview is marked `pathTruncated`.

Extraction uses [node-tar](https://github.com/isaacs/node-tar) and Node's GZIP stream, including library support for USTAR, local PAX and GNU long names. Regular entry types are `File`/`OldFile`; directory entries use `Directory`. Absolute/Windows paths, `..` components, backslashes, links, devices, FIFOs and unsupported entries are refused and indexed. Global PAX and sparse metadata stop preparation explicitly rather than allowing ignored attributes to change the meaning of a file. Individual metadata records are limited to 1 MiB. Duplicate paths and file/directory conflicts never overwrite earlier files. Private directories/files use modes 0700/0600; ownership and executable permissions are not restored. The actual expanded stream is metered before the TAR parser, including refused entries, metadata and trailing padding. Nested compression is refused and padding after TAR EOF is discarded without accumulating it in the parser; cached results also count against the call's expanded-byte budget. GZIP/TAR corruption or exceeding byte/entry limits stops preparation and removes its folder. Nested HAR, video and archives remain ordinary extracted files; journal/CDB/PCAP payloads are not decoded.

Download deadlines abort the HTTP request itself; actual byte limits and metadata-size checks still apply. These deadlines cover downloads, not the complete synchronous tool call: HAR preparation and archive extraction add time. Client tool deadlines remain independent; see the verification commands below.

### Video frame previews

Available starting with version `0.1.2`.

`get_attachments` automatically samples video attachments into **up to 24 JPEG frames distributed across the recording**, including its beginning and a point near its end. Short videos use roughly one sample per second. Images keep their aspect ratio, are not upscaled, and fit within 1280 × 1280 pixels. The original video remains available. Audio is not extracted.

Install a maintained **FFmpeg release with both `ffmpeg` and `ffprobe` on the machine running Jira MCP**. The agents need only a file/image-reading tool with access to the attachment directory. The npm package does not install or download executable binaries. If a desktop MCP client's `PATH` does not include FFmpeg, set `JIRA_FFMPEG_PATH` and, if needed, `JIRA_FFPROBE_PATH` in its env file. A missing decoder does not prevent MCP startup or ordinary attachment downloads.

The video attachment's JSON line retains its existing fields and adds:

```json
{
  "frames": {
    "directory": "/absolute/cache/session/DEMO-123/101-recording.mp4.frames-<sha256>",
    "count": 24,
    "sampled": true
  }
}
```

The folder contains `frame-001.jpg`, `frame-002.jpg`, etc., and **`manifest.json`**. The manifest lists each filename, `requestedTimeSeconds`, and byte size, plus the source SHA-256 and video duration. Times are requested seek positions, not guarantees of exact decoded frame timestamps. Read the frames in manifest order. This is a visual overview: events between samples, fine text reduced by scaling, and audio can be missed. Keep the video for detailed investigation.

If extraction is disabled, unavailable, unsafe, unsupported, or fails, the response instead includes `frames.skipped` with a short reason. The video still has a valid `path`; it is not reported as a failed download. Frame extraction also runs for reused video files. Successful previews are reused with `frames.reused=true` after validating the source hash and cached files. A source content change uses a different folder. Incomplete or unsafe caches are refused; remove the affected frame folder from your controlled cache directory to regenerate it on the next call. Old frame folders follow the existing session cleanup policy and are not automatically deleted.

Safety limits are fixed to keep the change small:

- At most 24 frames per video, 1 MB per JPEG, 10 MB of JPEGs per video, and 20 MB across one tool call. Reused frames count toward the call budget; failed decoder output also consumes its reserved allowance. These limits are separate from the original download byte limits.
- A shared 60-second extraction budget per call, including probing; decoder processes run sequentially with one decoding/filtering/encoding thread. HTTP download time is governed separately by `JIRA_DOWNLOAD_TIMEOUT_MS` and `JIRA_DOWNLOAD_IDLE_TIMEOUT_MS`.
- Source duration must be finite and at most 24 hours; dimensions must be positive, at most 8192 per side and 8,847,360 pixels in total. Unknown duration and sources beyond these limits are skipped.
- Only MOV/MP4, Matroska/WebM and AVI containers are accepted, with H.264, HEVC, VP8, VP9, AV1, MPEG-4 or MJPEG video. Video MIME types and common video filename extensions trigger probing; metadata does not bypass container validation.
- Decoder processes use argument arrays without a shell, receive no Jira credentials, and have bounded stdout/stderr. Input is restricted to the local file protocol and the allowed container formats; playlists, network protocols, and MOV external track references are blocked. FFmpeg writes JPEGs to a bounded pipe; Node writes private files in a temporary directory and publishes the complete folder by atomic rename. Failures remove temporary results. Paths and cached files are checked for symlinks.

The input restrictions use FFmpeg's documented [protocol allowlist](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options), [format allowlist and MOV options](https://ffmpeg.org/ffmpeg-formats.html). They reduce exposure but are **not an OS sandbox**. Use an up-to-date decoder and an attachment directory controlled by the MCP account; hostile concurrent filesystem changes are outside the store's existing threat model. `-max_alloc` limits an individual allocation, not total process memory. Strong process-wide memory or privilege isolation requires host/container limits.

## Limits

- No server token or response-size cap for issue reads and comment pages.
- Search: 1–50 results, default 10; no output token budget.
- Downloads: configurable per-file and per-call byte limits, plus the attachment response budget above.
- Video previews: sampled frames and separate resource budgets as described above.
- Other Jira JSON responses: an 8 MB transport safety limit.
- Success confirmations: up to 50 reference tokens; errors: approximately 200.
- Combined tool definitions: tested to remain within 700 reference tokens.

Reference token counts use `cl100k_base`, not Claude's private tokenizer. Client output limits, model context limits, and HTTP timeouts remain independent of server truncation rules.

## Development and verification

```sh
npm run verify   # Typecheck source/tests, run tests, build
npm run smoke    # Connect to the built server without contacting Jira
npm pack         # Build an installable npm archive
```

Tests use synthetic Jira responses and exercise MCP over stdio. CI runs on Node.js 22 and 24 without Jira credentials.

To test a real issue after configuring `.env`:

```sh
npm run smoke -- --live --issue DEMO-123
```

Replace `DEMO-123` with an issue you can access. This explicitly enables read-only mode, reads the issue and its comments, searches for it, and downloads its attachments. The smoke log reports tool names and success/error flags without printing issue or attachment contents; no comments or transitions are written.

Optional large-file checks use synthetic loopback HTTP data only and remove their temporary downloads:

```sh
npx tsx scripts/check-large-attachment.ts # 429 MB, MCP SDK, server heap capped at 128 MiB
npx tsx scripts/check-claude-large.ts     # Real authenticated Claude Code CLI, 429 MB, throttled download
```

The Claude check requires `claude` on PATH and an existing Claude login. It enables only this synthetic MCP server and Read, removes inherited environment variables naming MCP timeouts, and reports the removed variable names without their values. It tests the client's default timeout settings without overrides. Verification requires a successful download of the expected byte size, completed HAR preparation, and successful Read results for the exact returned index and indexed response-body paths with the requested line limits. A server-only or MCP SDK check does not establish Claude Code timeout compatibility. `TEST_FILE_BYTES` and `TEST_DELAY_MS` can adjust these fixtures. The fixtures do not use Jira credentials or working attachments. Desktop/other clients, a real 429 MB Jira download, and slower calls require their own verification.

Local verification on 2026-10-06:

- Real Claude Code CLI 2.1.289 completed a synthetic 429,000,000-byte HAR call with default client timeouts: 117.2 seconds downloading, 3.8 seconds preparing, 121.0 seconds total. The client then read the index and selected lines of the response body. The fixture included a 150 MB schema string and a large ignored `_initiator`; server heap stayed below 82 MB with a 128 MiB heap limit (peak observed RSS about 258 MB). This establishes the tested CLI scenario, not every client/network duration.
- After review fixes and stricter exact-path assertions, the Claude recheck connected to MCP but the account's session usage limit prevented every tool call. The final processor version therefore has not been reverified through Claude; the earlier 121-second result applies to the implementation before these fixes. The stricter assertions have regression tests for wrong paths, incomplete preparation, missing/failed results, and quota responses.
- A separate MCP SDK call rechecked the final HAR processors with the same-size synthetic file and 150 MB schema under the same heap limit: 0.7 seconds downloading, 4.2 seconds preparing, 4.9 seconds total, peak observed heap about 81 MB and RSS about 273 MB. SDK success is recorded separately from the Claude client check.
- A real 45.6 MB HAR produced 751 index rows, including 39 JSON-RPC errors at HTTP 200 with error text; 424 responses remained explicitly unknown. Real samples confirmed `params.path` and `params.th`. No `params.method` occurred in the available HAR samples; that field and alternate nested ConfD error-data shapes remain covered by synthetic fixtures rather than a real example.
- A real diagnostic TAR.GZ was rechecked with node-tar after review and produced 160 rows. All 129 accepted regular files matched an independent Python `tarfile` streaming comparison byte for byte; member payloads totalled 46,171,361 bytes. Four link/special entries were refused. No working files or credentials are included in the package or test fixtures.

To test an npm archive through `npx` before publishing:

```sh
npm run smoke -- --command npx --args -y --package /absolute/path/to/package.tgz jira-mcp
```

The `examples/claude-code.json` and `examples/claude-desktop.json` files contain npm configurations. Use `examples/local.json` when running a source checkout, or the archive command above to test an unpublished build.

## Structure

```text
src/
  index.ts          # Configuration, startup, stdio
  server.ts         # Tool registration and deployment profiles
  config.ts         # Environment and env-file validation
  jira/
    client.ts       # HTTP requests and scoped authentication
    errors.ts       # Safe errors and redaction
    types.ts        # Jira DTOs used by the implementation
  adf.ts            # Plain text / ADF conversion
  output.ts         # Serialization and bounded-output helpers
  attachments.ts    # Paths, download deadlines/limits, preparation caches
  har.ts            # Streaming HAR index, RPC checks, readable bodies
  archives.ts       # Safe streaming TAR.GZ extraction and index
  tools/            # Five tool schemas and handlers
```

References: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Atlassian API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account), [Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro).
