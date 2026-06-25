# Core Lambda Deployment Guide

The `cwf-core-lambda` function handles all core API endpoints, including tools, parts, actions, missions, and profiles.

---

## Deployment Options

There are two main scripts available to deploy changes to the Lambda function. Run them from the project's **root directory**.

### 1. Fast Code-Only Deployment (Recommended)
Use this option when you have only modified local logic (e.g. editing `index.js` or files in `shared/`). It excludes the `node_modules` folder, reducing packaging and transfer size to `<100 KB`.
- **Time to deploy**: ~3 seconds
- **Command**:
  ```bash
  ./scripts/deploy/deploy-lambda-fast.sh core cwf-core-lambda
  ```

### 2. Full Layer & Config Deployment
Use this option when you have added new npm packages to `package.json`, modified database credentials in `.env.local`, or updated other environment variables. This script bundles local `node_modules` and re-configures the Lambda function's layers and environment variable settings.
- **Time to deploy**: ~2–3 minutes (due to node_modules packaging)
- **Command**:
  ```bash
  ./scripts/deploy/deploy-lambda-with-layer.sh core cwf-core-lambda
  ```

---

## Troubleshooting

### Issue: "Cannot find module '/opt/nodejs/...'"
**Cause**: The common layer `cwf-common-nodejs` is not attached to the Lambda.
**Solution**: Run the full deployment script `./scripts/deploy/deploy-lambda-with-layer.sh core cwf-core-lambda` to re-attach the layer and configure layers.

### Issue: "Connection was closed before we received a valid response..."
**Cause**: Zipping `node_modules` and uploading a large package (>50 MB) timed out or encountered network packet loss.
**Solution**: If you only updated logic in `index.js`, use the fast deployment script `./scripts/deploy/deploy-lambda-fast.sh core cwf-core-lambda`.

---

## Testing After Deployment

Verify that the Lambda function is active and responding by querying the health endpoint:
```bash
curl https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/health
```
**Expected response**:
```json
{"status":"ok","timestamp":"2026-..."}
```
