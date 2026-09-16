#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const config = await loadConfig().catch(error => {
    if (error instanceof ConfigError) return error;
    throw error;
  });
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
main().catch(error => {
  // Config errors are deliberately authored messages; never dump a stack or env.
  console.error(error instanceof Error ? error.message : 'Jira MCP startup failed.');
  process.exitCode = 1;
});
