# API Gateway endpoint checklist

**Status:** current-state reference — keep this accurate.
**Last verified:** 2026-08-01.

## When adding a new endpoint

1. **Add the endpoint handler** to the relevant Lambda (often `lambda/core/index.js`,
   but check `docs/architecture/LAMBDA_ARCHITECTURE.md` first — many resources
   have their own dedicated Lambda now, not everything lives in core).
2. **Create the API Gateway resource and method:**
   ```bash
   ./scripts/add-api-endpoint.sh /api/your-endpoint GET
   ```
3. **Verify the authorizer is configured:**
   ```bash
   bash scripts/verify/verify-api-authorizers.sh
   ```
4. **Deploy to prod:**
   ```bash
   aws apigateway create-deployment --rest-api-id 0720au267k --stage-name prod --region us-west-2
   ```
5. **Test the endpoint:**
   ```bash
   curl https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/your-endpoint \
     -H "authorization: Bearer YOUR_TOKEN"
   ```

## Common mistakes

- Forgetting to add an authorizer (causes empty organization context)
- Using the wrong Lambda function — check which one actually owns the
  resource before assuming; two Lambdas can have confusingly similar names
  (e.g. a stale, unwired duplicate can coexist with the live one). Confirm
  with:
  ```bash
  aws apigateway get-resources --rest-api-id 0720au267k --region us-west-2 \
    --query "items[?path=='/api/your/path']"
  aws apigateway get-integration --rest-api-id 0720au267k --resource-id <id> \
    --http-method GET --region us-west-2 --query "uri"
  ```
- Not deploying after making changes
- `OPTIONS` method should **not** have an authorizer (CORS preflight)

## Public endpoints (no auth required)

- `/api/health` — health check
- `/api/schema` — API schema

All other endpoints must have an authorizer configured.

## Known drift to be aware of

`.github/workflows/verify-api.yml` calls `scripts/verify-api-authorizers.sh`,
but the script actually lives at `scripts/verify/verify-api-authorizers.sh`.
The weekly CI verification job is likely failing on that path mismatch —
not yet fixed as of this doc's last-verified date.
