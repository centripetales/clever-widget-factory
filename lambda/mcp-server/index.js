import express from 'express';
import transport from './transport.js';
import { requireAuth } from './auth.js';

const PORT = 3000;

// Runs behind the Lambda Web Adapter extension, which translates Lambda
// Function URL invocations into real HTTP requests against this server —
// see docs/architecture/LAMBDA_ARCHITECTURE.md for why this is needed
// (the MCP SDK's transport expects real Node req/res, not API Gateway
// event JSON).
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log(`Incoming: ${req.method} ${req.originalUrl} | origin=${req.get('origin') || 'none'} | auth=${req.get('authorization') ? 'present' : 'none'} | ua=${req.get('user-agent') || 'none'}`);
  next();
});

// Unauthenticated — needed for basic reachability checks.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Everything else (the actual MCP endpoint) requires the static bearer token.
app.use(requireAuth);

await transport.bootstrap(app);

app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}`);
});
