import { test, describe } from 'node:test';
import assert from 'node:assert';

process.env.COGNITO_USER_POOL_ID = 'us-west-2_test';
process.env.CLAUDE_APP_CLIENT_ID = 'claude-client';
process.env.PUBLIC_BASE_URL = 'https://mcp.example.test';
process.env.COGNITO_DOMAIN = 'auth.example.test';

const { checkClaims, unauthorized, requireAuth } = await import('./auth.js');
const discovery = await import('./discovery.js');

const validClaims = { token_use: 'access', client_id: 'claude-client', scope: 'cwf-mcp/read', sub: 'user-1' };

function fakeRes() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('checkClaims', () => {
  test('accepts a Claude access token with the read scope', () => {
    assert.strictEqual(checkClaims(validClaims), true);
  });
  test('rejects an ID token', () => {
    assert.strictEqual(checkClaims({ ...validClaims, token_use: 'id' }), false);
  });
  test("rejects another client's token (e.g. the web app)", () => {
    assert.strictEqual(checkClaims({ ...validClaims, client_id: 'web-client' }), false);
  });
  test('rejects a token without the read scope', () => {
    assert.strictEqual(checkClaims({ ...validClaims, scope: 'openid email' }), false);
    assert.strictEqual(checkClaims({ ...validClaims, scope: undefined }), false);
  });
  test('accepts the read scope among others', () => {
    assert.strictEqual(checkClaims({ ...validClaims, scope: 'openid cwf-mcp/read' }), true);
  });
});

describe('requireAuth', () => {
  test('401 with resource_metadata pointer when no token', async () => {
    const res = fakeRes();
    let called = false;
    await requireAuth({ get: () => undefined }, res, () => { called = true; });
    assert.strictEqual(called, false);
    assert.strictEqual(res.statusCode, 401);
    assert.match(res.headers['WWW-Authenticate'], /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
    assert.match(res.headers['WWW-Authenticate'], /scope="cwf-mcp\/read cwf-mcp\/write"/);
  });
  test('401 for a malformed token', async () => {
    const res = fakeRes();
    await requireAuth({ get: () => 'Bearer not-a-jwt' }, res, () => assert.fail('should not call next'));
    assert.strictEqual(res.statusCode, 401);
  });
  test('unauthorized() sets 401', () => {
    assert.strictEqual(unauthorized(fakeRes()).statusCode, 401);
  });
});

describe('discovery documents', () => {
  test('protected resource metadata names this server and its URL exactly', () => {
    const m = discovery.protectedResourceMetadata();
    assert.strictEqual(m.resource, 'https://mcp.example.test/mcp');
    assert.deepStrictEqual(m.authorization_servers, ['https://mcp.example.test']);
  });
  test('authorization server metadata points at Cognito and advertises DCR + PKCE', () => {
    const m = discovery.authorizationServerMetadata();
    assert.strictEqual(m.issuer, 'https://mcp.example.test');
    assert.strictEqual(m.authorization_endpoint, 'https://auth.example.test/oauth2/authorize');
    assert.strictEqual(m.token_endpoint, 'https://auth.example.test/oauth2/token');
    assert.strictEqual(m.registration_endpoint, 'https://mcp.example.test/register');
    assert.deepStrictEqual(m.code_challenge_methods_supported, ['S256']);
    assert.deepStrictEqual(m.token_endpoint_auth_methods_supported, ['none']);
    assert.strictEqual(m.client_id_metadata_document_supported, undefined);
  });
  test('/register always returns the pre-registered public client', () => {
    const r = discovery.registrationResponse({ client_name: 'Claude', redirect_uris: ['https://evil.test/cb'] });
    assert.strictEqual(r.client_id, 'claude-client');
    assert.deepStrictEqual(r.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
    assert.strictEqual(r.token_endpoint_auth_method, 'none');
  });
});
