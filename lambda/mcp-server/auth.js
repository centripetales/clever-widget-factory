import crypto from 'crypto';

// Static shared-secret bearer token. OAuth (Cognito + CloudFront header-fix)
// was attempted and torn down — Claude's MCP OAuth client has known bugs
// (see anthropics/claude-ai-mcp issues #406, #112, #644) around discovery
// and ignoring configured request headers, so it's not currently viable.
// This static token, set as a custom request header on the connector, is
// the working approach until that's fixed upstream.
const requiredEnv = ['MCP_AUTH_TOKEN'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const expectedToken = Buffer.from(process.env.MCP_AUTH_TOKEN);

function timingSafeTokenEqual(candidate) {
  const candidateBuf = Buffer.from(candidate);
  if (candidateBuf.length !== expectedToken.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedToken);
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer realm="cwf-mcp-server"');
  return res.status(401).json({ error: 'Unauthorized' });
}

export async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return unauthorized(res);

  if (timingSafeTokenEqual(match[1])) {
    return next();
  }

  return unauthorized(res);
}
