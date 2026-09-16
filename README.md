# Jira MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for Jira Cloud. Read and search issues, download attachments to real files, add comments, and transition issues.

Runs over **stdio** on Node.js 22 or later, using the official MCP TypeScript SDK. Designed for Claude Code, its subagents, and Claude Desktop.

## Connect through npm

Package: [`@misha_m.g/jira-mcp`](https://www.npmjs.com/package/@misha_m.g/jira-mcp).

Create an env file using [`.env.example`](.env.example), fill in your Jira credentials, and add the following to your MCP client configuration:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": [
        "-y",
        "@misha_m.g/jira-mcp@0.1.1",
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
| `JIRA_MAX_FILE_BYTES` | No | `50000000` (50 MB) per file |
| `JIRA_MAX_CALL_BYTES` | No | `200000000` (200 MB) downloaded per call |
| `JIRA_TIMEOUT_MS` | No | `30000` per HTTP request, including body consumption |

The server loads an env file **only** when `--env-file` is supplied. Process environment variables override file values. Relative attachment paths resolve against the env file's directory, or the process working directory without an env file. `${VAR}` interpolation inside values is not supported.

Credentials and downloads are excluded from Git and npm packaging. Missing or invalid configuration does not interrupt the MCP handshake or tool listing: tool calls return an explicit configuration error. Fix the environment or env file and restart the MCP server to reload it. Read-only mode still controls tool registration; if the env file cannot be read or the read-only setting is invalid, only read tools are exposed. Authentication and permission errors also surface when calling Jira. Tokens and raw Jira error bodies are not returned in tool errors.

## Tools

| Tool | Inputs | Result |
|---|---|---|
| `get_issue` | `key`, optional `comments` (default `false`) | Full projected issue as JSON; all accessible comments when requested |
| `search_issues` | `jql`, optional `limit` (default 10, maximum 50) | One JSON line per issue, followed by `shown` and `has_more` |
| `get_attachments` | `key`, optional `ids` (up to 100) | Downloaded file paths and metadata, or explicit skip reasons |
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

Filenames are sanitized and prefixed with the attachment ID. Repeated calls use stable paths; an existing regular file of the same size is reused without a checksum comparison. Downloads use temporary files and atomic renames. Partial files are removed, and byte limits are enforced against the actual stream. Files are not executed or unpacked.

The base directory, session directory, issue directory, and existing destination must not be symlinks. Use a directory controlled by the account running the server; the server is not designed for a directory tree concurrently modified by an untrusted local user.

A generated session ID identifies a **server process**, not a Claude conversation. Subagents sharing the server share its files. Set the same `JIRA_SESSION_ID` for multiple processes that should share a directory, and change it for a new session. Old sessions are not deleted automatically.

The attachment response currently has a 4,000-token reference budget. If more entries would exceed it, remaining files are not downloaded and the response reports this. Read their IDs with `get_issue`, then call `get_attachments` with selected IDs. Paths are never shortened.

HTTP redirects are refused; attachment requests use `redirect=false` so credentials cannot be forwarded to another host. A site returning a redirect despite that flag produces an explicit error.

## Limits

- No server token or response-size cap for issue reads and comment pages.
- Search: 1–50 results, default 10; no output token budget.
- Downloads: configurable per-file and per-call byte limits, plus the attachment response budget above.
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

Replace `DEMO-123` with an issue you can access. This explicitly enables read-only mode, reads the issue and its comments, searches for it, and downloads its attachments. The output contains issue data; no comments or transitions are written.

To test an archive through `npx` before publishing:

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
  attachments.ts    # Paths, downloads, byte limits
  tools/            # Five tool schemas and handlers
```

References: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Atlassian API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account), [Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro).
