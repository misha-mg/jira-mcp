# Changelog

## 0.1.3 — Unreleased

Publication is pending a repeat of the final 429 MB HAR check through an authenticated Claude Code client. The account's session usage limit currently prevents that check. See the verification notes in [README.md](README.md).

### Added

- Downloads support 512 MiB per attachment and 1 GiB per call by default. Separate total and idle deadlines abort the HTTP request; actual byte limits and partial-file cleanup remain enforced.
- HAR files are prepared automatically by `get_attachments` using a streaming parser. One JSONL index records each HTTP request, JSON-RPC methods and parameters, body sizes/paths, and RPC errors even at HTTP 200. Missing or unrecognizable responses remain explicitly unknown.
- HAR request/response bodies are written to numbered files and prepared for line-based reading, including long `get_schema` strings. Readable views are labelled when formatting changes their serialization.
- TAR.GZ/TGZ files are streamed into an indexed extraction directory. Files retain their bytes; nested attachments are not processed. The index records paths, sizes, entry types and text/binary/unknown hints.

### Safety and compatibility

- Archive traversal, absolute paths, links, special files, duplicate paths and file/directory conflicts are refused. Global PAX, sparse metadata and nested compression stop preparation explicitly. Expanded bytes, including metadata and padding, and entry counts are limited; partial preparation folders are removed on failure or cancellation.
- Completed HAR/archive preparations are cached by attachment ID and original size. Completed original downloads and the existing video frame previews are preserved.
- No new MCP tools or input parameters are required. Existing env files that explicitly set smaller byte limits keep those values; update the relevant settings to use the new defaults.
- Claude Code and other MCP clients enforce their own deadlines independently of download settings. A successful SDK/server check does not establish client timeout compatibility.
