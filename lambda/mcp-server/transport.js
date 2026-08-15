import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import mcpServer from './mcp-server.js';

const MCP_PATH = '/mcp';

async function bootstrap(app) {
  app.post(MCP_PATH, postRequestHandler);
  app.get(MCP_PATH, sessionNotSupportedHandler);
  app.delete(MCP_PATH, sessionNotSupportedHandler);
}

async function postRequestHandler(req, res) {
  try {
    // New MCP server + transport per request — this is a stateless deployment,
    // no session state carried between requests.
    const newMcpServer = mcpServer.create();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport.close();
      newMcpServer.close();
    });

    await newMcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Error handling MCP request:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

function sessionNotSupportedHandler(req, res) {
  res.status(405).set('Allow', 'POST').json({ error: 'This is a stateless server; GET/DELETE session endpoints are not supported.' });
}

export default { bootstrap };
