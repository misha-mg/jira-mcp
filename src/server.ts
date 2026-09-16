import { McpServer } from '@modelcontextprotocol/server';
import { ConfigError, type Config } from './config.js';
import { JiraClient } from './jira/client.js';
import { redact, SafeError } from './jira/errors.js';
import { AttachmentStore } from './attachments.js';
import { short } from './output.js';
import { getIssue, getIssueSchema } from './tools/get-issue.js';
import { searchIssues, searchIssuesSchema } from './tools/search-issues.js';
import { getAttachments, getAttachmentsSchema } from './tools/get-attachments.js';
import { addComment, addCommentSchema } from './tools/add-comment.js';
import { transitionIssue, transitionIssueSchema } from './tools/transition-issue.js';

export function createServer(config: Config | ConfigError, client?: JiraClient, store?: AttachmentStore) {
  const server = new McpServer({ name: 'jira-mcp', version: '0.1.1' });
  const configurationMessage = config instanceof ConfigError ? config.message : '';
  const context = config instanceof ConfigError ? undefined : {
    config, client: client ?? new JiraClient(config), store: store ?? new AttachmentStore(config),
  };
  const run = async (action: (client: JiraClient, store: AttachmentStore) => Promise<string>) => {
    if (!context) return { isError: true, content: [{ type: 'text' as const, text: `Configuration error: ${configurationMessage}` }] };
    const { config, client, store } = context;
    try { return { content: [{ type: 'text' as const, text: redact(await action(client, store), config.token, config.email) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: redact(short(error instanceof SafeError ? error.message : 'Unexpected Jira response or local operation failure.', 190), config.token, config.email) }] };
    }
  };
  server.registerTool('get_issue', { description: 'JSON: key,summary,status,type,priority,labels,fixVersions,description,attachments; all comments when requested. Full plain text; no server truncation or response cap.', inputSchema: getIssueSchema }, args => run(client => getIssue(client, args)));
  server.registerTool('search_issues', { description: 'JSON lines: key,summary,status,type,updated; then shown,has_more. Limit defaults to 10, max 50. Narrow JQL for more.', inputSchema: searchIssuesSchema }, args => run(client => searchIssues(client, args)));
  server.registerTool('get_attachments', { description: 'Download issue files. JSON lines: path,filename,mimeType,size or skipped; then counts. IDs default to all. Never returns contents.', inputSchema: getAttachmentsSchema }, args => run((client, store) => getAttachments(client, store, args)));
  if (!config.readOnly) {
    server.registerTool('add_comment', { description: 'Post plain text. Returns comment id and confirmation.', inputSchema: addCommentSchema }, args => run(client => addComment(client, args)));
    server.registerTool('transition_issue', { description: 'Move to target status name; resolution when required. Optional comment is atomic. Returns status and confirmation; errors list available options.', inputSchema: transitionIssueSchema }, args => run(client => transitionIssue(client, args)));
  }
  return server;
}
