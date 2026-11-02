# Design Document

## Overview

Cognito does all the real OAuth work: sign-in (Google or password), PKCE, the authorization code, access and refresh tokens, and revocation. The MCP_Server adds a thin Discovery_Layer that fills the one gap, client registration, by always handing out the same pre-registered public client. It then checks Cognito access tokens on every request and scopes queries to the caller's organizations.

```
Claude app ──POST /mcp (no token)──▶ MCP_Server ──401 + resource_metadata──▶ Claude
Claude ──GET /.well-known/oauth-protected-resource──▶ { authorization_servers: [https://mcp.stargazer-farm.com] }
Claude ──GET /.well-known/oauth-authorization-server──▶ Cognito endpoints + registration_endpoint
Claude ──POST /register──▶ { client_id: <Claude_App_Client> }
Claude ──browser──▶ Cognito /oauth2/authorize (Google) ──code──▶ claude.ai/api/mcp/auth_callback
Claude ──POST Cognito /oauth2/token (PKCE, public client)──▶ access + refresh tokens
Claude ──POST /mcp (Bearer access token)──▶ MCP_Server verifies JWT → Accessible_Orgs → scoped tools
```

## 1. Hosting

- **New API Gateway HTTP API** `cwf-mcp-api` with a `$default` route → Lambda proxy integration to `cwf-mcp-server`. A `$default` stage gives no path prefix, so `/.well-known/*` and `/mcp` sit at the root.
- **Custom domain** `mcp.stargazer-farm.com` (regional) with an ACM certificate in us-west-2, mapped to the `$default` stage.
- **DNS at Namecheap** (manual): one CNAME for ACM validation, one CNAME `mcp` → the API Gateway regional domain name.
- HTTP API passes `Authorization` through untouched. No CloudFront.
- The existing REST route `/prod/api/mcp` on `cwf-api` is left as is until the new domain is verified, then removed in a later cleanup.
- Lambda Web Adapter handles HTTP API (payload v2) events, so the Express app needs no change for this.

## 2. Cognito: Claude_App_Client

New app client in pool `us-west-2_84dcGaogx`:

| Setting | Value |
|---|---|
| Client secret | None (public client) |
| Allowed flows | Authorization code grant only |
| Callback URLs | `https://claude.ai/api/mcp/auth_callback` |
| Identity providers | Google, Cognito user pool |
| Scopes | `cwf-mcp/read` only (custom resource server, see below) |
| Refresh token rotation | Enabled |
| Access token validity | 1 hour (default) |
| Refresh token validity | 30 days (default) |

**Resource server** `cwf-mcp` with one scope `read`. We use a custom scope rather than `openid email profile` so that:
- the token says plainly that it's read-only (Requirement 3), and
- Cognito returns no ID token, so Claude never sees an `iss` that differs from the issuer in our metadata.

## 3. Discovery_Layer (unauthenticated routes in `index.js`)

Served before `requireAuth`. Values come from env vars: `PUBLIC_BASE_URL`, `COGNITO_DOMAIN`, `COGNITO_USER_POOL_ID`, `CLAUDE_APP_CLIENT_ID`.

**`GET /.well-known/oauth-protected-resource`** (also at `/.well-known/oauth-protected-resource/mcp`)
```json
{
  "resource": "https://mcp.stargazer-farm.com/mcp",
  "authorization_servers": ["https://mcp.stargazer-farm.com"],
  "scopes_supported": ["cwf-mcp/read"],
  "bearer_methods_supported": ["header"]
}
```

**`GET /.well-known/oauth-authorization-server`** (also served as `/.well-known/openid-configuration`)
```json
{
  "issuer": "https://mcp.stargazer-farm.com",
  "authorization_endpoint": "https://cwf-stargazer.auth.us-west-2.amazoncognito.com/oauth2/authorize",
  "token_endpoint": "https://cwf-stargazer.auth.us-west-2.amazoncognito.com/oauth2/token",
  "revocation_endpoint": "https://cwf-stargazer.auth.us-west-2.amazoncognito.com/oauth2/revoke",
  "registration_endpoint": "https://mcp.stargazer-farm.com/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["cwf-mcp/read"]
}
```
`client_id_metadata_document_supported` is deliberately left out, so Claude uses DCR, i.e. our `/register`.

**`POST /register`** (JSON body, RFC 7591)
- Returns `201` with `client_id: CLAUDE_APP_CLIENT_ID`, `token_endpoint_auth_method: "none"`, `grant_types`, `response_types`, and `redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]`.
- Creates nothing. Requested `redirect_uris` other than the Claude_Callback are ignored; Cognito would reject them at authorize time anyway.

**`401` from `requireAuth`**
```
WWW-Authenticate: Bearer resource_metadata="https://mcp.stargazer-farm.com/.well-known/oauth-protected-resource", scope="cwf-mcp/read"
```

## 4. Token verification (`auth.js`, replaces the static token)

- Verify the RS256 signature against the Cognito JWKS (`jwks-rsa`, cached), with `iss` = `https://cognito-idp.us-west-2.amazonaws.com/us-west-2_84dcGaogx`.
- Require `token_use === "access"`, `client_id === CLAUDE_APP_CLIENT_ID` (Cognito access tokens carry `client_id`, not `aud`), and `scope` containing `cwf-mcp/read`.
- On success, set `req.cognitoUserId = sub`. On any failure, return the `401` above.
- `MCP_AUTH_TOKEN` and the static-token code are removed.

## 5. Organization scoping

- Port the membership + partner-access query from `lambda/authorizer/index.js` (`getUserOrganizationData`) into `mcp-server` as a function returning `accessibleOrgIds`. It's a copy of one query, because `mcp-server` is ESM and the authorizer is CommonJS with its own bundle; no shared-module refactor.
- Cache per `sub` for 5 minutes, the same as the authorizer.
- `transport.js` passes `accessibleOrgIds` into `mcpServer.create({ accessibleOrgIds })`. Tools close over it.
- `search_claims`: `s.organization_id = $1` → `s.organization_id = ANY($1::uuid[])` in both query paths.
- `get_observation_photos`: join `states` and add `s.organization_id = ANY($2::uuid[])`. Return "observation not found" when it isn't accessible.
- Empty `accessibleOrgIds` → the tool returns the "not a member" error (Requirement 2.5).

## 6. Deploy

`scripts/deploy/deploy-lambda-fast.sh` excludes `node_modules`, and `cwf-mcp-server` has no dependency layer, so that script produces a Lambda that crashes on start (`Cannot find package 'express'`). Don't use it for this function. Deploy with dependencies included:

```bash
cd lambda/mcp-server && npm ci --omit=dev && zip -qr /tmp/mcp.zip . -x "*.test.js" && aws lambda update-function-code --function-name cwf-mcp-server --zip-file fileb:///tmp/mcp.zip --region us-west-2
```

Lambda environment variables (in addition to the existing `DB_*`):

| Variable | Value |
|---|---|
| `COGNITO_USER_POOL_ID` | `us-west-2_84dcGaogx` |
| `CLAUDE_APP_CLIENT_ID` | `1taqbi3qib26m8egge5kr7vm36` |
| `COGNITO_DOMAIN` | `cwf-stargazer.auth.us-west-2.amazoncognito.com` |
| `PUBLIC_BASE_URL` | `https://mcp.stargazer-farm.com` |

`MCP_AUTH_TOKEN` is no longer read and can be removed.

## Known Risks (verify first, in this order)

1. **`resource` parameter.** Claude sends `resource=<Public_URL>` (RFC 8707) to `/oauth2/authorize` and `/oauth2/token`. If Cognito rejects it, the fallback is a pass-through `/authorize` on our domain that strips `resource` and 302s to Cognito, plus a pass-through `/token`. That's still stateless, but it puts our Lambda in the sign-in path. A side benefit: `/authorize` could then add `identity_provider=Google` to skip the hosted-UI button.
2. **Issuer mismatch.** Our metadata `issuer` is our domain, while Cognito's token `iss` differs. With no ID token (custom scope only), Claude shouldn't check this. If it does, the same pass-through fallback applies.
3. **Self-registration.** Sign-up is set for the whole user pool, not per client. A Google sign-in for an uninvited email may still create a Cognito user through the existing Pre-SignUp trigger. Requirement 2.5 means such a user gets no data. Fixing the linking or sign-up behaviour itself is out of scope.
4. **Account linking.** A person who signed up with Google first and then with email has two `sub`s. Only the one with memberships sees data. This is a known, pre-existing issue, out of scope.

## Testing

- Unit tests (`npm test` in `lambda/mcp-server`, Node's built-in runner like the other lambdas; vitest excludes `lambda/`): token verification (valid, wrong client, ID token, expired, missing scope); metadata documents; `/register` response; org scoping SQL parameters for both tools, including a cross-org `observation_id` returning nothing.
- Manual end to end: add the connector on claude.ai with only the URL → Google sign-in → `search_claims` returns own-org data → same on the phone app → revoke in Cognito → Claude asks to reconnect.
