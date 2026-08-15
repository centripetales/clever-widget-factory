# Deploy scripts

## Versioned rollback via Lambda aliases

There's no separate dev/staging environment for these Lambdas — deploys go
straight to production. `deploy-lambda-fast.sh` gives functions that opt in
to this pattern a way to roll back instantly instead of by hand:

- Every deploy publishes an immutable numbered **version** and moves the
  `live` **alias** to point at it.
- API Gateway (or whatever else triggers the function) is wired to invoke
  the `:live`-qualified ARN, not the bare function name (which always means
  `$LATEST`).
- Rolling back is just repointing the alias — no rebuild, no redeploy.

Use `rollback-lambda.sh <function-name>` (no version arg) to list the
current and recent versions, then `rollback-lambda.sh <function-name>
<version>` to move `live` back to a known-good one. Roll forward the same
way once you're ready.

### Onboarding a function to this pattern (one-time, per function)

Only functions with a `live` alias get their traffic moved by
`deploy-lambda-fast.sh` — for everything else it still publishes a version
on each deploy (harmless, just an unreferenced snapshot) but nothing points
at it. To onboard a function fronted by API Gateway:

```bash
FN=your-function-name
VERSION=$(aws lambda publish-version --function-name "$FN" --region us-west-2 --query 'Version' --output text)
aws lambda create-alias --function-name "$FN" --name live --function-version "$VERSION" --region us-west-2
```

Then, for each API Gateway method integrated with this function, re-point
`put-integration`'s `--uri` at the alias-qualified ARN
(`arn:...:function:$FN:live` instead of `arn:...:function:$FN`), grant API
Gateway permission to invoke the alias:

```bash
aws lambda add-permission \
  --function-name "$FN" \
  --qualifier live \
  --statement-id apigateway-invoke-live \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-west-2:131745734428:0720au267k/*/*/*" \
  --region us-west-2
```

and deploy the stage:

```bash
aws apigateway create-deployment --rest-api-id 0720au267k --stage-name prod --region us-west-2
```

If the function has a dedicated `wire-api-gateway.sh` (e.g.
`lambda/states/wire-api-gateway.sh`), update its `LAMBDA_ARN` to the
`:live`-qualified form too, so future re-wiring of new routes doesn't
silently fall back to `$LATEST`.

Functions triggered by something other than API Gateway (e.g.
`cwf-image-compressor`, which is invoked by an S3 bucket-notification
event) need the equivalent change made to that trigger's config instead of
an API Gateway integration — not yet done for any such function, since it's
a different, less-scriptable cutover with a higher blast radius if
misconfigured.

**Currently onboarded:** `cwf-states-lambda`.
