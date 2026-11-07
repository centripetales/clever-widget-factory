#!/bin/bash
set -e

# Deploy Lambda with layer support
# Usage: ./deploy-lambda-with-layer.sh <lambda-dir> <function-name> [layer-arn] [timeout-seconds]

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <lambda-dir> <function-name> [layer-arn] [timeout-seconds]"
  echo "Example: $0 action-scoring cwf-action-scoring"
  exit 1
fi

LAMBDA_DIR="$1"
FUNCTION_NAME="$2"
LAYER_ARG="$3"
TIMEOUT_ARG="$4"
REGION="us-west-2"
ROLE_ARN="arn:aws:iam::131745734428:role/lambda-execution-role"

# The shared layer: the version given, or the latest one.
LAYER_ARN="${LAYER_ARG:-$(aws lambda list-layer-versions --layer-name cwf-common-nodejs --region "$REGION" \
  --query 'LayerVersions[0].LayerVersionArn' --output text)}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../lambda/$LAMBDA_DIR"

# Load environment variables from .env.local
if [ -f "$SCRIPT_DIR/../../.env.local" ]; then
  echo "📋 Loading environment variables from .env.local..."
  # Export all non-comment, non-empty lines that look like KEY=VALUE
  export $(grep -v '^#' "$SCRIPT_DIR/../../.env.local" | grep -v '^$' | grep '=' | xargs)
fi

# The function's environment: what it has now (none for a new function),
# with the .env.local values that are set laid over it, as CLI JSON. Values
# are read from the environment, never pasted into code.
environment_json() {
  python3 -c '
import json, os, sys
existing = json.load(sys.stdin) or {}
for key in ["DB_PASSWORD", "DB_HOST", "DB_USER", "DB_NAME", "DB_PORT", "MAXWELL_AGENT_ID",
            "MAXWELL_AGENT_ALIAS_ID", "MAXWELL_AGENT_ALIAS_ID_DEEP", "BEDROCK_REGION",
            "SARI_SARI_AGENT_ID", "SARI_SARI_AGENT_ALIAS_ID", "ML_LAMBDA_NAME",
            "WS_API_ENDPOINT", "PERSPECTIVES_QUEUE_URL"]:
    if os.environ.get(key):
        existing[key] = os.environ[key]
print(json.dumps({"Variables": existing}))
'
}

echo "📦 Installing dependencies..."
npm install --production

echo "📦 Packaging Lambda (all files + node_modules/)..."
zip -r function.zip . \
  --exclude "*.test.js" \
  --exclude "*.test.ts" \
  --exclude "deploy.sh" \
  --exclude "wire-api-gateway.sh" \
  --exclude "function.zip" \
  --exclude ".git/*" \
  --exclude "node_modules/.cache/*"

echo "🚀 Deploying to AWS Lambda ($FUNCTION_NAME)..."
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" &>/dev/null; then
  echo "♻️  Updating function code..."
  DEPLOY_OUTPUT=$(aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file fileb://function.zip \
    --region "$REGION" 2>&1)
  
  if [ $? -ne 0 ]; then
    echo "❌ Deployment failed!"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi
  
  echo "⏳ Waiting for code update to complete..."
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
  
  echo "⚙️  Updating configuration with layer and environment variables..."
  CONFIG=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --output json)

  # Keep its other layers (e.g. the Lambda Web Adapter); only the shared
  # layer is set to $LAYER_ARN.
  LAYERS=$(echo "$CONFIG" | python3 -c '
import json, sys
layers = [l["Arn"] for l in json.load(sys.stdin).get("Layers", []) if ":layer:cwf-common-nodejs:" not in l["Arn"]]
print(" ".join(layers + [sys.argv[1]]))
' "$LAYER_ARN")

  # Its existing variables (e.g. COGNITO_*) are kept; stop rather than
  # replace them if they can't be read.
  ENV_JSON=$(echo "$CONFIG" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin).get("Environment", {}).get("Variables", {})))' | environment_json)
  if [ -z "$ENV_JSON" ]; then
    echo "❌ Could not read the function's environment variables; configuration left unchanged."
    exit 1
  fi

  # Memory and timeout stay as they are unless a timeout is given.
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --layers $LAYERS \
    ${TIMEOUT_ARG:+--timeout "$TIMEOUT_ARG"} \
    --environment "$ENV_JSON" \
    --region "$REGION" >/dev/null
else
  echo "🆕 Creating new function..."
  ENV_JSON=$(echo '{}' | environment_json)
  
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb://function.zip \
    --layers "$LAYER_ARN" \
    --timeout "${TIMEOUT_ARG:-30}" \
    --memory-size 512 \
    --environment "$ENV_JSON" \
    --region "$REGION" >/dev/null
fi

NEW_SHA=$(echo "$DEPLOY_OUTPUT" | grep -o '"CodeSha256": "[^"]*"' | cut -d'"' -f4)
echo "✅ Deployed with CodeSha256: $NEW_SHA"

echo "⏳ Waiting for Lambda to be ready..."
aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION" 2>/dev/null || sleep 3

# Ensure API Gateway has permission to invoke this Lambda
API_ID="0720au267k"
echo "🔑 Ensuring API Gateway invoke permission..."
if ! aws lambda get-policy --function-name "$FUNCTION_NAME" --region "$REGION" 2>/dev/null | grep -q "apigateway-invoke"; then
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id apigateway-invoke \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:131745734428:${API_ID}/*" \
    --region "$REGION" >/dev/null 2>&1
  echo "✅ API Gateway invoke permission added"
else
  echo "✅ API Gateway invoke permission already exists"
fi

echo "🔍 Verifying deployment..."
CURRENT_SHA=$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Configuration.CodeSha256' --output text)

if [ "$NEW_SHA" = "$CURRENT_SHA" ]; then
  echo "✅ Deployment verified: $CURRENT_SHA"
else
  echo "⚠️  Warning: SHA mismatch. Deployed: $NEW_SHA, Current: $CURRENT_SHA"
fi

echo "🧹 Cleaning up..."
rm function.zip

echo "✅ Deployment complete!"
echo ""
echo "Function: $FUNCTION_NAME"
echo "Layer: $LAYER_ARN"
