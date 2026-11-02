import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Cognito OAuth for Claude's custom connector. Claude signs the user in
// through Cognito directly (see discovery.js for how it finds Cognito and
// gets the client ID) and sends the resulting Cognito *access* token here.
const requiredEnv = ['COGNITO_USER_POOL_ID', 'CLAUDE_APP_CLIENT_ID', 'PUBLIC_BASE_URL'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const COGNITO_REGION = process.env.COGNITO_REGION || 'us-west-2';
const COGNITO_ISSUER = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`;
export const REQUIRED_SCOPE = 'cwf-mcp/read';

const client = jwksClient({
  jwksUri: `${COGNITO_ISSUER}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Cognito access tokens carry client_id (not aud) and a space-separated scope.
// Rejecting ID tokens and other clients' tokens keeps the web app's tokens
// from being usable here and vice versa.
export function checkClaims(decoded) {
  if (decoded.token_use !== 'access') return false;
  if (decoded.client_id !== process.env.CLAUDE_APP_CLIENT_ID) return false;
  const scopes = (decoded.scope || '').split(' ');
  return scopes.includes(REQUIRED_SCOPE);
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { issuer: COGNITO_ISSUER, algorithms: ['RS256'] }, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded);
    });
  });
}

// Claude only starts sign-in on a 401, and finds the authorization server
// through the resource_metadata pointer.
export function unauthorized(res) {
  res.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${process.env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", scope="${REQUIRED_SCOPE}"`
  );
  return res.status(401).json({ error: 'Unauthorized' });
}

export async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return unauthorized(res);

  try {
    const decoded = await verifyToken(match[1]);
    if (!checkClaims(decoded)) return unauthorized(res);
    req.cognitoUserId = decoded.sub;
    return next();
  } catch (err) {
    console.log('Token rejected:', err.message);
    return unauthorized(res);
  }
}
