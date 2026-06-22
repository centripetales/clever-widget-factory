#!/bin/bash
set -e

# Fast Lambda deployment script (Code-only update)
# Usage: ./deploy-lambda-fast.sh <lambda-dir> <function-name>
# Example: ./deploy-lambda-fast.sh core cwf-core-lambda

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <lambda-dir> <function-name>"
  echo "Example: $0 core cwf-core-lambda"
  exit 1
fi

LAMBDA_DIR="$1"
FUNCTION_NAME="$2"
REGION="us-west-2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../lambda/$LAMBDA_DIR"

if [ ! -d "." ]; then
  echo "❌ Error: Lambda directory lambda/$LAMBDA_DIR does not exist"
  exit 1
fi

echo "📦 Packaging code for $FUNCTION_NAME (excluding node_modules)..."
zip -r function.zip . \
  --exclude "node_modules/*" \
  --exclude "*.test.js" \
  --exclude "*.test.ts" \
  --exclude "deploy.sh" \
  --exclude "wire-api-gateway.sh" \
  --exclude "function.zip" \
  --exclude ".git/*" > /dev/null

echo "🚀 Uploading code directly to AWS Lambda ($FUNCTION_NAME)..."
START_TIME=$SECONDS
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb://function.zip \
  --region "$REGION" > /dev/null

ELAPSED=$((SECONDS - START_TIME))

echo "🧹 Cleaning up local ZIP package..."
rm -f function.zip

echo "✅ Code deployed successfully to $FUNCTION_NAME in ${ELAPSED}s!"
