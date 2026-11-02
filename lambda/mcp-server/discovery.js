// OAuth discovery for Claude's custom connector. Cognito does all the real
// OAuth work (sign-in, PKCE, codes, tokens, refresh) but supports neither
// Dynamic Client Registration nor Client ID Metadata Documents, one of which
// Claude needs to connect from just a URL. So this server advertises itself
// as the authorization server, points every endpoint at Cognito, and answers
// /register with the single pre-registered public Cognito client. Nothing is
// created or stored.
import { REQUIRED_SCOPE, WRITE_SCOPE } from './auth.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

if (!process.env.COGNITO_DOMAIN) {
  throw new Error('Missing required environment variable: COGNITO_DOMAIN');
}

export function protectedResourceMetadata() {
  const base = process.env.PUBLIC_BASE_URL;
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [REQUIRED_SCOPE, WRITE_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata() {
  const base = process.env.PUBLIC_BASE_URL;
  const cognito = `https://${process.env.COGNITO_DOMAIN}`;
  return {
    issuer: base,
    authorization_endpoint: `${cognito}/oauth2/authorize`,
    token_endpoint: `${cognito}/oauth2/token`,
    revocation_endpoint: `${cognito}/oauth2/revoke`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [REQUIRED_SCOPE, WRITE_SCOPE],
  };
}

export function registrationResponse(body = {}) {
  return {
    client_id: process.env.CLAUDE_APP_CLIENT_ID,
    client_name: body.client_name,
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: `${REQUIRED_SCOPE} ${WRITE_SCOPE}`,
  };
}

export function mountDiscovery(app) {
  const resource = (req, res) => res.json(protectedResourceMetadata());
  const authServer = (req, res) => res.json(authorizationServerMetadata());

  app.get('/.well-known/oauth-protected-resource', resource);
  app.get('/.well-known/oauth-protected-resource/mcp', resource);
  app.get('/.well-known/oauth-authorization-server', authServer);
  app.get('/.well-known/openid-configuration', authServer);
  app.post('/register', (req, res) => res.status(201).json(registrationResponse(req.body)));
}
