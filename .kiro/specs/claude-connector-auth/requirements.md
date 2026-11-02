# Requirements Document

## Introduction

CWF already has an MCP server (`lambda/mcp-server`, Lambda `cwf-mcp-server`) with two observation tools, `search_claims` and `get_observation_photos`. Today it is protected by one static shared bearer token and every query is hardcoded to a single organization (`mcp-server.js:10`). It is also currently down: the deployed bundle has no `node_modules`, so every request returns 502.

This feature lets any invited CWF member add the server as a custom connector in the Claude app (web, desktop, mobile) and sign in with the same Cognito account they use for CWF, typically "Continue with Google". Each person then sees only their own organizations' data, the same as in the CWF web app.

An earlier attempt at Cognito OAuth was torn down. The main gap is that Cognito supports neither Dynamic Client Registration (DCR) nor Client ID Metadata Documents (CIMD), and Claude's connector needs one of them unless every user types in a client ID by hand.

## Glossary

- **MCP_Server**: The `cwf-mcp-server` Lambda (Express behind Lambda Web Adapter)
- **Connector**: A custom connector added in Claude under Customize → Connectors, pointing at the MCP_Server URL
- **Claude_Callback**: `https://claude.ai/api/mcp/auth_callback`, the redirect URI used by claude.ai web, desktop, mobile and Cowork
- **Claude_App_Client**: A new Cognito app client in pool `us-west-2_84dcGaogx`, used only by Claude
- **Discovery_Layer**: The metadata and `/register` endpoints the MCP_Server serves so Claude can find Cognito and get the Claude_App_Client ID
- **Accessible_Orgs**: The organizations a user can read: active direct memberships plus partner access, computed the same way as `lambda/authorizer`
- **Public_URL**: `https://mcp.stargazer-farm.com/mcp`

## Requirements

### Requirement 1: Connect with only a URL

**User Story:** As a farm member, I want to add the connector by pasting one URL and signing in, so that I don't have to handle client IDs or tokens.

#### Acceptance Criteria

1. WHEN a user adds a custom connector with the Public_URL and default settings, THE Connector SHALL complete sign-in without the user entering a client ID, client secret, or header
2. THE sign-in page SHALL be the existing Cognito hosted sign-in (`cwf-stargazer.auth.us-west-2.amazoncognito.com`) offering Google and email/password
3. AFTER connecting on the web, THE Connector SHALL work in the Claude mobile app without further setup
4. THE Connector SHALL stay connected across Cognito access-token expiry through refresh tokens, with no repeat sign-in until the refresh token expires or is revoked

### Requirement 2: Identity and organization scoping

**User Story:** As a member, I want Claude to see only my organizations' data, so that farm data stays private between organizations.

#### Acceptance Criteria

1. THE MCP_Server SHALL reject any MCP request without a valid Cognito access token issued to the Claude_App_Client, responding `401` with a `WWW-Authenticate` header that points at the protected resource metadata
2. THE MCP_Server SHALL resolve the caller's Accessible_Orgs from the token's `sub` using the same rules as `lambda/authorizer`
3. EVERY tool query SHALL be limited to the caller's Accessible_Orgs; the hardcoded `ORGANIZATION_ID` SHALL be removed
4. `get_observation_photos` SHALL return photos only when the observation belongs to one of the caller's Accessible_Orgs (today it does not check)
5. WHEN the caller has no active membership, THE MCP_Server SHALL return a clear "not a member of any CWF organization" tool error and no data

### Requirement 3: Read-only

#### Acceptance Criteria

1. ALL tools exposed through the Connector SHALL be read-only
2. THE Claude_App_Client SHALL be granted only a read scope

### Requirement 4: Stable public address

#### Acceptance Criteria

1. THE MCP_Server SHALL be reachable at the Public_URL through a custom domain
2. THE Discovery_Layer SHALL be served from the root of that domain (`/.well-known/...`), with no stage prefix
3. THE `Authorization` header SHALL reach the MCP_Server unmodified

### Requirement 5: No new data structures

#### Acceptance Criteria

1. THE solution SHALL NOT add database tables or store tokens; Cognito issues, refreshes and revokes all tokens
2. `/register` SHALL NOT create Cognito clients; it SHALL return the one pre-registered Claude_App_Client

### Requirement 6: Working deploy

#### Acceptance Criteria

1. THE deployed MCP_Server bundle SHALL include its runtime dependencies so it starts successfully
2. `GET /health` SHALL return `{"status":"ok"}` without authentication

## Out of Scope

- Public (no sign-in) tools for outside agents, and listing in the MCP Registry or Claude Connectors Directory (planned later; does not change the URL or auth design)
- Claude Code support (it uses a loopback redirect on a random port, which Cognito's exact-match callback URLs can't accept)
- Fixing the existing account-linking gaps (Google-first users becoming separate accounts, first-login linking error); see Design, Known Risks
- Write tools
