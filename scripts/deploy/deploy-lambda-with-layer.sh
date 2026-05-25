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
LAYER_ARN="${3:-arn:aws:lambda:us-west-2:131745734428:layer:cwf-common-nodejs:28}"
TIMEOUT_SECONDS="${4:-30}"
REGION="us-west-2"
ROLE_ARN="arn:aws:iam::131745734428:role/lambda-execution-role"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../lambda/$LAMBDA_DIR"

# Load environment variables from .env.local
if [ -f "$SCRIPT_DIR/../../.env.local" ]; then
  echo "📋 Loading environment variables from .env.local..."
  # Export all non-comment, non-empty lines that look like KEY=VALUE
  export $(grep -v '^#' "$SCRIPT_DIR/../../.env.local" | grep -v '^$' | grep '=' | xargs)
fi

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
  # Fetch existing environment variables to preserve them (e.g. COGNITO_* vars)
  EXISTING_VARS=$(aws lambda get-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query 'Environment.Variables' \
    --output json 2>/dev/null || echo '{}')
  
  # Start with existing vars, then overlay .env.local vars
  ENV_VARS=$(echo "$EXISTING_VARS" | python3 -c "
import sys, json
existing = json.load(sys.stdin) or {}
# Overlay .env.local vars (only if set)
overlay = {}
$([ -n "$DB_PASSWORD" ] && echo "overlay['DB_PASSWORD'] = '$DB_PASSWORD'")
$([ -n "$DB_HOST" ] && echo "overlay['DB_HOST'] = '$DB_HOST'")
$([ -n "$DB_USER" ] && echo "overlay['DB_USER'] = '$DB_USER'")
$([ -n "$DB_NAME" ] && echo "overlay['DB_NAME'] = '$DB_NAME'")
$([ -n "$DB_PORT" ] && echo "overlay['DB_PORT'] = '$DB_PORT'")
$([ -n "$MAXWELL_AGENT_ID" ] && echo "overlay['MAXWELL_AGENT_ID'] = '$MAXWELL_AGENT_ID'")
$([ -n "$MAXWELL_AGENT_ALIAS_ID" ] && echo "overlay['MAXWELL_AGENT_ALIAS_ID'] = '$MAXWELL_AGENT_ALIAS_ID'")
$([ -n "$MAXWELL_AGENT_ALIAS_ID_DEEP" ] && echo "overlay['MAXWELL_AGENT_ALIAS_ID_DEEP'] = '$MAXWELL_AGENT_ALIAS_ID_DEEP'")
$([ -n "$BEDROCK_REGION" ] && echo "overlay['BEDROCK_REGION'] = '$BEDROCK_REGION'")
$([ -n "$SARI_SARI_AGENT_ID" ] && echo "overlay['SARI_SARI_AGENT_ID'] = '$SARI_SARI_AGENT_ID'")
$([ -n "$SARI_SARI_AGENT_ALIAS_ID" ] && echo "overlay['SARI_SARI_AGENT_ALIAS_ID'] = '$SARI_SARI_AGENT_ALIAS_ID'")
$([ -n "$ML_LAMBDA_NAME" ] && echo "overlay['ML_LAMBDA_NAME'] = '$ML_LAMBDA_NAME'")
$([ -n "$WS_API_ENDPOINT" ] && echo "overlay['WS_API_ENDPOINT'] = '$WS_API_ENDPOINT'")
$([ -n "$PERSPECTIVES_QUEUE_URL" ] && echo "overlay['PERSPECTIVES_QUEUE_URL'] = '$PERSPECTIVES_QUEUE_URL'")
existing.update(overlay)
# Output as KEY=VALUE format for AWS CLI
print('{' + ','.join(f'{k}={v}' for k,v in existing.items()) + '}')
" 2>/dev/null)
  
  # Fallback if python merge fails — use .env.local vars only
  if [ -z "$ENV_VARS" ] || [ "$ENV_VARS" = "{}" ]; then
    ENV_VARS="{"
    [ -n "$DB_PASSWORD" ] && ENV_VARS="${ENV_VARS}DB_PASSWORD=$DB_PASSWORD,"
    [ -n "$DB_HOST" ] && ENV_VARS="${ENV_VARS}DB_HOST=$DB_HOST,"
    [ -n "$DB_USER" ] && ENV_VARS="${ENV_VARS}DB_USER=$DB_USER,"
    [ -n "$DB_NAME" ] && ENV_VARS="${ENV_VARS}DB_NAME=$DB_NAME,"
    [ -n "$DB_PORT" ] && ENV_VARS="${ENV_VARS}DB_PORT=$DB_PORT,"
    [ -n "$MAXWELL_AGENT_ID" ] && ENV_VARS="${ENV_VARS}MAXWELL_AGENT_ID=$MAXWELL_AGENT_ID,"
    [ -n "$MAXWELL_AGENT_ALIAS_ID" ] && ENV_VARS="${ENV_VARS}MAXWELL_AGENT_ALIAS_ID=$MAXWELL_AGENT_ALIAS_ID,"
    [ -n "$MAXWELL_AGENT_ALIAS_ID_DEEP" ] && ENV_VARS="${ENV_VARS}MAXWELL_AGENT_ALIAS_ID_DEEP=$MAXWELL_AGENT_ALIAS_ID_DEEP,"
    [ -n "$BEDROCK_REGION" ] && ENV_VARS="${ENV_VARS}BEDROCK_REGION=$BEDROCK_REGION,"
    [ -n "$SARI_SARI_AGENT_ID" ] && ENV_VARS="${ENV_VARS}SARI_SARI_AGENT_ID=$SARI_SARI_AGENT_ID,"
    [ -n "$SARI_SARI_AGENT_ALIAS_ID" ] && ENV_VARS="${ENV_VARS}SARI_SARI_AGENT_ALIAS_ID=$SARI_SARI_AGENT_ALIAS_ID,"
    [ -n "$WS_API_ENDPOINT" ] && ENV_VARS="${ENV_VARS}WS_API_ENDPOINT=$WS_API_ENDPOINT,"
    [ -n "$PERSPECTIVES_QUEUE_URL" ] && ENV_VARS="${ENV_VARS}PERSPECTIVES_QUEUE_URL=$PERSPECTIVES_QUEUE_URL,"
    ENV_VARS="${ENV_VARS%,}}"
    echo "⚠️  Could not merge existing env vars, using .env.local only"
  else
    echo "✅ Merged existing env vars with .env.local"
  fi
  
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --layers "$LAYER_ARN" \
    --timeout "$TIMEOUT_SECONDS" \
    --memory-size 512 \
    --environment "Variables=$ENV_VARS" \
    --region "$REGION" >/dev/null
else
  echo "🆕 Creating new function..."
  # Build environment variables JSON - include all common Lambda env vars
  ENV_VARS="{"
  [ -n "$DB_PASSWORD" ] && ENV_VARS="${ENV_VARS}DB_PASSWORD=$DB_PASSWORD,"
  [ -n "$DB_HOST" ] && ENV_VARS="${ENV_VARS}DB_HOST=$DB_HOST,"
  [ -n "$DB_USER" ] && ENV_VARS="${ENV_VARS}DB_USER=$DB_USER,"
  [ -n "$DB_NAME" ] && ENV_VARS="${ENV_VARS}DB_NAME=$DB_NAME,"
  [ -n "$DB_PORT" ] && ENV_VARS="${ENV_VARS}DB_PORT=$DB_PORT,"
  [ -n "$MAXWELL_AGENT_ID" ] && ENV_VARS="${ENV_VARS}MAXWELL_AGENT_ID=$MAXWELL_AGENT_ID,"
  [ -n "$MAXWELL_AGENT_ALIAS_ID" ] && ENV_VARS="${ENV_VARS}MAXWELL_AGENT_ALIAS_ID=$MAXWELL_AGENT_ALIAS_ID,"
  [ -n "$MAXWELL_AGENT_ALIAS_ID_DEEP" ] && ENV_VARS="${ENV_VARS}MAXWELL_AGENT_ALIAS_ID_DEEP=$MAXWELL_AGENT_ALIAS_ID_DEEP,"
  [ -n "$BEDROCK_REGION" ] && ENV_VARS="${ENV_VARS}BEDROCK_REGION=$BEDROCK_REGION,"
  [ -n "$SARI_SARI_AGENT_ID" ] && ENV_VARS="${ENV_VARS}SARI_SARI_AGENT_ID=$SARI_SARI_AGENT_ID,"
  [ -n "$SARI_SARI_AGENT_ALIAS_ID" ] && ENV_VARS="${ENV_VARS}SARI_SARI_AGENT_ALIAS_ID=$SARI_SARI_AGENT_ALIAS_ID,"
  [ -n "$ML_LAMBDA_NAME" ] && ENV_VARS="${ENV_VARS}ML_LAMBDA_NAME=$ML_LAMBDA_NAME,"
  [ -n "$WS_API_ENDPOINT" ] && ENV_VARS="${ENV_VARS}WS_API_ENDPOINT=$WS_API_ENDPOINT,"
  # Remove trailing comma and close JSON
  ENV_VARS="${ENV_VARS%,}}"
  
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file fileb://function.zip \
    --layers "$LAYER_ARN" \
    --timeout "$TIMEOUT_SECONDS" \
    --memory-size 512 \
    --environment "Variables=$ENV_VARS" \
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
