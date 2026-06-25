# Scripts

## Lambda Deployment

All Lambda deployment scripts are located under the `scripts/deploy/` directory.

### `deploy-lambda-with-layer.sh`

Clean deployment script that builds dependencies (`npm install --production`), merges configuration variables, links Layers, and updates function code. Takes **20–45 seconds**.

**Usage:**
```bash
./scripts/deploy/deploy-lambda-with-layer.sh <lambda-dir> <function-name> [layer-arn] [timeout-seconds]
```

**Example:**
```bash
# Deploy core Lambda with standard common Layer
./scripts/deploy/deploy-lambda-with-layer.sh core cwf-core-lambda
```

### `deploy-lambda-fast.sh`

Ultra-fast code update script. Zips and uploads your code *without zipping `node_modules` or modifying configurations*. Since all packages are contained in the function Layer, this script updates your Lambda in **1–3 seconds**.

**Usage:**
```bash
./scripts/deploy/deploy-lambda-fast.sh <lambda-dir> <function-name>
```

**Example:**
```bash
# Fast deploy code changes to core Lambda
./scripts/deploy/deploy-lambda-fast.sh core cwf-core-lambda
```

## API Gateway Scripts

## Automatic CORS Setup

### `setup-cors.sh`

Automatically configures CORS for any API Gateway endpoint. This script:
- Finds or creates the API Gateway resource
- Creates/updates the OPTIONS method for preflight requests
- Sets up CORS headers (Allow-Origin, Allow-Methods, Allow-Headers)
- Deploys changes to production

**Usage:**
```bash
./scripts/setup-cors.sh <endpoint_path>
```

**Examples:**
```bash
# Simple endpoint
./scripts/setup-cors.sh /api/mission_attachments

# Parameterized endpoint
./scripts/setup-cors.sh /api/mission_attachments/{id}

# Actions endpoint
./scripts/setup-cors.sh /api/actions

# Actions with ID
./scripts/setup-cors.sh /api/actions/{id}
```

**When to use:**
- After creating a new API endpoint in Lambda
- When you see CORS errors in the browser console
- After adding a new HTTP method (GET, POST, PUT, DELETE) to an endpoint

**What it does:**
1. Finds the API Gateway resource for the endpoint
2. Creates the resource if it doesn't exist
3. Creates/updates the OPTIONS method
4. Configures CORS headers:
   - `Access-Control-Allow-Origin: *`
   - `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`
   - `Access-Control-Allow-Headers: Content-Type,Authorization`
5. Deploys to production stage

**Note:** Changes may take 1-2 minutes to propagate. Clear your browser cache if you still see CORS errors.

## Quick Reference

### Common Endpoints That Need CORS

After adding a new endpoint, run:
```bash
./scripts/setup-cors.sh /api/<your-endpoint>
```

If you have a parameterized endpoint:
```bash
./scripts/setup-cors.sh /api/<your-endpoint>
./scripts/setup-cors.sh /api/<your-endpoint>/{id}
```

### Troubleshooting

**Still seeing CORS errors?**
1. Wait 1-2 minutes for changes to propagate
2. Clear browser cache (Cmd+Shift+R or Ctrl+Shift+R)
3. Check that the endpoint path is correct
4. Verify the Lambda function returns CORS headers in responses

**Check if CORS is configured:**
```bash
curl -X OPTIONS 'https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/<your-endpoint>' \
  -H 'Origin: http://localhost:8080' \
  -H 'Access-Control-Request-Method: GET' \
  -v
```

You should see `Access-Control-Allow-Origin: *` in the response headers.
