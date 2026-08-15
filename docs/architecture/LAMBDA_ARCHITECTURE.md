# Lambda architecture

**Status:** current-state reference — keep this accurate as the architecture evolves.
**Last verified:** 2026-08-01, against the live AWS account and this checkout.

## What actually happened vs. the original plan

A January 2026 plan ([git history: `docs/LAMBDA_ARCHITECTURE_PLAN.md`, now removed](.)) proposed splitting a
monolithic `cwf-core-lambda` into small per-resource Lambdas behind a shared
layer, in three phases (proof-of-concept on `explorations`, then extract
`tools`/`parts`/`missions`, then per-Lambda IAM roles). A separate,
never-executed plan in `lambda/README.md` proposed a different path
(refactor `core/index.js` into `handlers/`/`services/` subfolders first, then
maybe split into Lambdas publishing a `@cwf/core-utils` npm package).

Neither plan matches what's actually deployed today. What happened instead:

- **Far more got extracted than either plan scoped**: `lambda/` currently has
  50+ separate function directories — `actions`, `states`, `history`,
  `organization`, `financial-records`, `explorations`, `maxwell-*`,
  `sari-sari-*`, and many more — each its own deployed Lambda.
- **`tools` and `parts` were never extracted** — routing for those still
  lives inside `lambda/core/index.js`, which remains a large multi-resource
  handler (grep `path.match` in that file to see what it still owns).
- **No per-Lambda IAM roles were created** (Phase 3 of the original plan).
  Check current roles with `aws iam list-roles --query "Roles[?contains(RoleName,'cwf')]"`
  — as of this writing only `cwf-maxwell-chat-role` exists beyond the
  generic `lambda-execution-role` shared by everything else.
- **The shared layer is real and in use**, but named `cwf-common-nodejs`,
  not `cwf-shared-layer` as originally proposed. `core/index.js` was never
  split into `handlers/`/`services/` files as `lambda/README.md` proposed —
  it's still one file per Lambda.

If you're deciding whether to extract another resource out of `core`, or add
IAM role separation, those are still open, valid ideas — just don't assume
either historical plan describes the current system.

## Dependency resolution — where a `require()` actually resolves from

Before adding a `package.json` to a Lambda directory or running `npm install`
to fix a missing-module error, check where the module should come from —
most Lambdas need **no bundled `node_modules` at all**. In order of
preference:

### 1. The shared layer (`cwf-common-nodejs`)

`lambda/layers/cwf-common-nodejs/nodejs/` contains both the shared
`/opt/nodejs/*` utility modules (`db.js`, `response.js`,
`authorizerContext.js`, `broadcastInvalidation.js`, `broadcastWs.js`, etc.)
and its own `node_modules` — currently including `pg`. AWS Lambda
automatically adds a layer's `nodejs/node_modules` to the module resolution
path for every function the layer is attached to, so `require('pg')` works
in any Lambda with this layer attached even though that Lambda has no
`node_modules` of its own.

Check what's actually in the layer before assuming a package needs
bundling:
```bash
ls lambda/layers/cwf-common-nodejs/nodejs/node_modules/
```

### 2. The AWS Lambda Node.js runtime

The managed `nodejs18.x`/`nodejs20.x` runtime ships the AWS SDK for
JavaScript v3 built in. `@aws-sdk/client-sqs`, `@aws-sdk/client-bedrock-runtime`,
and other `@aws-sdk/*` packages resolve at runtime without being in the
deployment package **or** the layer. Don't add these to a Lambda's
`package.json` unless you've confirmed the runtime version in use doesn't
cover the client you need.

### 3. The Lambda's own `node_modules`

Only needed for packages that are genuinely third-party and not covered by
either of the above — e.g. `sharp` and `exifr` in `cwf-image-compressor`,
which has its own `package.json` for exactly this reason. If a Lambda needs
one of these, give it a proper `package.json` and deploy with
`scripts/deploy/deploy-lambda-with-layer.sh`, which runs `npm install
--production` and bundles the result.

## Which deploy script to use

See "Deploying Lambda Updates" in the root `README.md` for the full
comparison and examples. Short version: if you didn't touch `package.json`
or add an import not covered by the layer/runtime, use
`scripts/deploy/deploy-lambda-fast.sh` (code-only, no `node_modules`
involved, seconds instead of tens of seconds). Only reach for
`deploy-lambda-with-layer.sh` when dependencies actually changed.

## How to verify instead of guessing

If you're unsure what's actually deployed or whether a fix landed, don't
reason about it in the abstract — download and inspect the live package
directly:
```bash
CODE_URL=$(aws lambda get-function --function-name <fn> --region us-west-2 \
  --query 'Code.Location' --output text)
curl -s "$CODE_URL" -o /tmp/live.zip && unzip -o -q /tmp/live.zip -d /tmp/live
ls /tmp/live/node_modules 2>&1   # empty/missing is normal if layer + runtime cover it
grep -c 'some_function_you_expect' /tmp/live/index.js
```
You can also invoke it directly to confirm it actually works, without going
through the frontend:
```bash
aws lambda invoke --function-name <fn> --region us-west-2 \
  --payload '<test event JSON>' --cli-binary-format raw-in-base64-out /tmp/out.json
cat /tmp/out.json
```
And to find which Lambda actually backs a given route (API Gateway resource
names and Lambda function names sometimes diverge — don't assume the
obvious name is the live one):
```bash
aws apigateway get-resources --rest-api-id <api-id> --region us-west-2 \
  --query "items[?path=='/api/your/path']"
aws apigateway get-integration --rest-api-id <api-id> --resource-id <id> \
  --http-method GET --region us-west-2 --query "uri"
```

## Known drift to be aware of

- `lambda/core/index.js` has a `/tools/{id}/history` handler that still
  queries pre-migration table names (`observations`/`observation_photos`/
  `observation_links`, renamed to `states`/`state_photos`/`state_links` by
  `migrations/002-rename-observations-to-states.sql`). It's wired live in
  API Gateway but the frontend calls a different route
  (`/api/history/tools/{id}`, backed by a separate `cwf-history-lambda`)
  instead — this looks like dead code left behind after the real
  implementation moved elsewhere, not something actively serving traffic.
