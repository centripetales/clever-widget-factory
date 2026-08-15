#!/bin/bash
set -e

# Roll a Lambda function's "live" alias back (or forward) to a specific
# published version — instant, no rebuild/redeploy. Only works for
# functions onboarded to the alias pattern (see scripts/deploy/README.md).
#
# Usage:
#   ./rollback-lambda.sh <function-name>            # list versions (read-only)
#   ./rollback-lambda.sh <function-name> <version>   # move live alias to <version>

if [ -z "$1" ]; then
  echo "Usage: $0 <function-name> [version]"
  echo "Example: $0 cwf-states-lambda"
  echo "Example: $0 cwf-states-lambda 12"
  exit 1
fi

FUNCTION_NAME="$1"
VERSION="$2"
REGION="us-west-2"

CURRENT=$(aws lambda get-alias \
  --function-name "$FUNCTION_NAME" \
  --name live \
  --region "$REGION" \
  --query 'FunctionVersion' --output text 2>/dev/null || echo "")

if [ -z "$CURRENT" ]; then
  echo "❌ $FUNCTION_NAME has no 'live' alias — it hasn't been onboarded to the alias pattern."
  exit 1
fi

if [ -z "$VERSION" ]; then
  echo "📍 $FUNCTION_NAME — live alias currently points at v${CURRENT}"
  echo ""
  echo "Recent published versions:"
  aws lambda list-versions-by-function \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query "reverse(sort_by(Versions[?Version!='\$LATEST'], &to_number(Version)))[:5].{Version:Version,LastModified:LastModified}" \
    --output table
  echo ""
  echo "To roll back: $0 $FUNCTION_NAME <version>"
  exit 0
fi

echo "🔄 Moving $FUNCTION_NAME live alias: v${CURRENT} → v${VERSION}"
aws lambda update-alias \
  --function-name "$FUNCTION_NAME" \
  --name live \
  --function-version "$VERSION" \
  --region "$REGION" > /dev/null

echo "✅ live alias now points at v${VERSION}"
