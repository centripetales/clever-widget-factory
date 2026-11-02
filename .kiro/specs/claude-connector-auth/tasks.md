# Implementation Plan

## Overview

Replace the MCP server's static token with Cognito OAuth that Claude's custom connector can complete from just a URL. Scope tools to the caller's organizations, serve it from `mcp.stargazer-farm.com`, and fix the broken deploy.

## Tasks

- [x] 1. Fix the deploy
  - Package `lambda/mcp-server` with production `node_modules` and redeploy `cwf-mcp-server`
  - Verify the Lambda starts (no `ERR_MODULE_NOT_FOUND` in logs)
  - _Requirements: 6.1_

- [x] 2. Cognito: resource server and Claude_App_Client (`claude-connector`, client ID `1taqbi3qib26m8egge5kr7vm36`)
  - Create resource server `cwf-mcp` with scope `read`
  - Create a public app client (code grant, PKCE, callback `https://claude.ai/api/mcp/auth_callback`, Google + Cognito IdPs, scope `cwf-mcp/read`, refresh token rotation on)
  - _Requirements: 1.2, 1.4, 3.2, 5.2_

- [ ] 3. Spike: confirm Cognito accepts Claude's authorize/token requests
  - Hand-run an authorize request with `resource=` + PKCE against the new client, then exchange the code at `/oauth2/token` with `resource=`
  - Decide: direct Cognito endpoints, or the pass-through fallback (Design, Known Risk 1)
  - Finding (2026-11-01): `/oauth2/authorize` accepts `resource=` (302 to login, same as without); `identity_provider=Google` goes straight to Google. Token exchange with `resource=` returns the same `invalid_grant` for a bogus code as without; a real code is only proven in task 8. Going with direct Cognito endpoints
  - _Requirements: 1.1_

- [x] 4. Discovery_Layer routes
  - Protected resource metadata, authorization server metadata, `POST /register`, served before `requireAuth`
  - Unit tests for each document
  - _Requirements: 1.1, 4.2, 5.2_

- [x] 5. Cognito access-token verification
  - Replace the static-token `auth.js` with JWKS verification (`token_use`, `client_id`, scope); `401` with `resource_metadata`
  - Remove `MCP_AUTH_TOKEN`
  - Unit tests
  - _Requirements: 2.1_

- [x] 6. Organization scoping
  - Port the Accessible_Orgs query from the authorizer, cached 5 min
  - Pass orgs into `mcpServer.create`; remove hardcoded `ORGANIZATION_ID`
  - `search_claims` → `ANY($n::uuid[])`; `get_observation_photos` → join `states`, check org
  - "Not a member" error for empty orgs
  - Unit tests, including the cross-org photo case
  - _Requirements: 2.2, 2.3, 2.4, 2.5_

- [x] 7. HTTP API + custom domain
  - Create HTTP API `cwf-mcp-api` (`$default` route → `cwf-mcp-server`), ACM cert for `mcp.stargazer-farm.com`, custom domain mapping
  - Stefan adds 2 CNAMEs at Namecheap (values provided)
  - Verify `GET https://mcp.stargazer-farm.com/health`
  - _Requirements: 4.1, 4.3, 6.2_

- [ ] 8. End-to-end on Claude
  - Add the connector on claude.ai with only the URL; sign in with Google; ask about recent observations
  - Repeat on the phone app; confirm another org's data isn't visible
  - _Requirements: 1.1, 1.3, 2.3_

- [ ] 9. Cleanup (after 8 passes)
  - Remove the `/prod/api/mcp` route on `cwf-api`
