#!/bin/bash
set -e

# Generic API Gateway wiring script
# Usage: ./scripts/wire-api-gateway.sh <lambda-function-name> <base-path> [endpoints...]
#
# Endpoints can be passed as:
#   - A single quoted string:  "GET,POST:/ GET:/{id}"
#   - Multiple arguments:       GET,POST:/ GET:/{id}
#   - Mixed (any combo works)
#
# Each endpoint spec is:  METHODS:PATH_SUFFIX
#   METHODS      — comma-separated HTTP methods, e.g. GET or GET,POST
#   PATH_SUFFIX  — path appended to /api/<base-path>, use / for the base itself
#
# Examples:
#   $0 cwf-experiences-lambda experiences "GET,POST:/ GET:/{id}"
#   $0 cwf-experiences-lambda experiences GET,POST:/ GET:/{id}
#   $0 cwf-energeia-lambda    energeia    GET:/schema POST:/refresh
#   $0 cwf-states-lambda      states      "GET,POST,PUT,DELETE:/ GET,PUT,DELETE:/{id}"
#
# If no endpoints are given, defaults to: GET,POST:/ GET:/{id}

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <lambda-function-name> <base-path> [endpoints...]"
  echo ""
  echo "Examples:"
  echo "  $0 cwf-experiences-lambda experiences 'GET,POST:/ GET:/{id}'"
  echo "  $0 cwf-energeia-lambda energeia GET:/schema POST:/refresh"
  exit 1
fi

FUNCTION_NAME="$1"
BASE_PATH="$2"
shift 2

# Collect all remaining args into a single string, then split on whitespace.
# This handles both "GET:/schema POST:/refresh" (one arg) and
# GET:/schema POST:/refresh (two args) identically.
if [ $# -eq 0 ]; then
  RAW_ENDPOINTS="GET,POST:/ GET:/{id}"
else
  RAW_ENDPOINTS="$*"
fi

# Normalise: strip stray braces/brackets that shells sometimes inject, collapse
# multiple spaces, trim leading/trailing whitespace.
RAW_ENDPOINTS=$(printf '%s' "$RAW_ENDPOINTS" | tr -s ' ' | sed 's/[{}]//g' | sed 's/^ //;s/ $//')

# Split into an array on whitespace
read -ra ENDPOINT_ARRAY <<< "$RAW_ENDPOINTS"

API_ID="0720au267k"
REGION="us-west-2"
AUTHORIZER_ID="pjg8xs"
ACCOUNT_ID="131745734428"

echo "🔧 Wiring $FUNCTION_NAME to API Gateway..."
echo "   Base path: /api/$BASE_PATH"
echo "   Endpoints: ${ENDPOINT_ARRAY[*]}"
echo ""

# Get Lambda ARN
LAMBDA_ARN=$(aws lambda get-function \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query 'Configuration.FunctionArn' \
  --output text)

echo "📍 Lambda ARN: $LAMBDA_ARN"

# Cache of all resources (refreshed after creates)
RESOURCES=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" --output json)

# Create a resource path if it doesn't already exist.
# Prints the resource ID to stdout; all other output goes to stderr.
create_resource_if_needed() {
  local PATH_ARG="$1"
  local PARENT_PATH
  local RESOURCE_NAME
  PARENT_PATH=$(dirname "$PATH_ARG")
  RESOURCE_NAME=$(basename "$PATH_ARG")

  local RESOURCE_ID
  RESOURCE_ID=$(echo "$RESOURCES" | jq -r ".items[] | select(.path == \"$PATH_ARG\") | .id")

  if [ -z "$RESOURCE_ID" ]; then
    echo "  Creating resource $PATH_ARG..." >&2

    local PARENT_ID
    if [ "$PARENT_PATH" = "/api" ]; then
      PARENT_ID=$(echo "$RESOURCES" | jq -r '.items[] | select(.path == "/api") | .id')
    else
      PARENT_ID=$(echo "$RESOURCES" | jq -r ".items[] | select(.path == \"$PARENT_PATH\") | .id")

      # Recursively create parent if missing
      if [ -z "$PARENT_ID" ]; then
        create_resource_if_needed "$PARENT_PATH" >/dev/null
        PARENT_ID=$(aws apigateway get-resources \
          --rest-api-id "$API_ID" --region "$REGION" \
          --query "items[?path=='$PARENT_PATH'].id" --output text)
      fi
    fi

    RESOURCE_ID=$(aws apigateway create-resource \
      --rest-api-id "$API_ID" \
      --parent-id "$PARENT_ID" \
      --path-part "$RESOURCE_NAME" \
      --region "$REGION" \
      --query 'id' --output text)

    # Refresh cache
    RESOURCES=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" --output json)

    echo "  ✅ Created resource: $RESOURCE_ID" >&2
  else
    echo "  ✅ Resource exists: $RESOURCE_ID" >&2
  fi

  printf '%s' "$RESOURCE_ID"
}

add_options_method() {
  local RESOURCE_ID="$1"

  echo "    Adding OPTIONS for CORS..."

  aws apigateway put-method \
    --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS --authorization-type NONE \
    --region "$REGION" >/dev/null 2>&1 || true

  aws apigateway put-integration \
    --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS --type MOCK \
    --request-templates '{"application/json": "{\"statusCode\": 200}"}' \
    --region "$REGION" >/dev/null 2>&1 || true

  aws apigateway put-method-response \
    --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS --status-code 200 \
    --response-parameters \
      '{"method.response.header.Access-Control-Allow-Headers":false,"method.response.header.Access-Control-Allow-Methods":false,"method.response.header.Access-Control-Allow-Origin":false}' \
    --region "$REGION" >/dev/null 2>&1 || true

  aws apigateway put-integration-response \
    --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS --status-code 200 \
    --response-parameters \
      '{"method.response.header.Access-Control-Allow-Headers":"'"'"'Content-Type,Authorization,X-Organization-Id,X-Connection-Id'"'"'","method.response.header.Access-Control-Allow-Methods":"'"'"'GET,POST,PUT,DELETE,OPTIONS'"'"'","method.response.header.Access-Control-Allow-Origin":"'"'"'*'"'"'"}' \
    --region "$REGION" >/dev/null 2>&1 || true

  echo "    ✅ OPTIONS configured"
}

add_method_and_integration() {
  local RESOURCE_ID="$1"
  local METHOD="$2"
  local FULL_PATH="$3"

  echo "    Adding $METHOD method..."

  aws apigateway put-method \
    --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method "$METHOD" --authorization-type CUSTOM \
    --authorizer-id "$AUTHORIZER_ID" \
    --region "$REGION" >/dev/null 2>&1 || true

  aws apigateway put-integration \
    --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" \
    --http-method "$METHOD" --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations" \
    --region "$REGION" >/dev/null 2>&1 || true

  # Per-route Lambda permission (best-effort; broad permission added at the end)
  local METHOD_LOWER
  METHOD_LOWER=$(echo "$METHOD" | tr '[:upper:]' '[:lower:]')
  local STATEMENT_ID
  STATEMENT_ID="apigateway-$(echo "$FULL_PATH" | tr '/' '-' | sed 's/^-//' | sed 's/{[^}]*}/id/g')-${METHOD_LOWER}"
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id "$STATEMENT_ID" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/$METHOD$FULL_PATH" \
    --region "$REGION" 2>/dev/null || true

  echo "    ✅ $METHOD configured"
}

# ── Main loop ────────────────────────────────────────────────────────────────
echo ""
for ENDPOINT_SPEC in "${ENDPOINT_ARRAY[@]}"; do
  # Strip any residual whitespace from the token
  ENDPOINT_SPEC="${ENDPOINT_SPEC// /}"
  [ -z "$ENDPOINT_SPEC" ] && continue

  # Split METHODS:PATH_SUFFIX on the first colon only
  METHODS_STR="${ENDPOINT_SPEC%%:*}"
  PATH_SUFFIX="${ENDPOINT_SPEC#*:}"

  # Build full path
  if [ "$PATH_SUFFIX" = "/" ]; then
    FULL_PATH="/api/$BASE_PATH"
  else
    FULL_PATH="/api/$BASE_PATH$PATH_SUFFIX"
  fi

  echo "📍 Setting up $FULL_PATH..."
  RESOURCE_ID=$(create_resource_if_needed "$FULL_PATH")

  # Split methods on comma without clobbering the outer IFS
  IFS=',' read -ra METHODS_ARRAY <<< "$METHODS_STR"
  for METHOD in "${METHODS_ARRAY[@]}"; do
    METHOD="${METHOD// /}"   # strip any stray spaces
    [ -z "$METHOD" ] && continue
    add_method_and_integration "$RESOURCE_ID" "$METHOD" "$FULL_PATH"
  done

  add_options_method "$RESOURCE_ID"
  echo ""
done

# Broad wildcard permission so API Gateway can always invoke this Lambda
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id "apigateway-invoke-all" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" \
  --region "$REGION" 2>/dev/null || true

# Deploy
echo "🚀 Deploying API Gateway..."
aws apigateway create-deployment \
  --rest-api-id "$API_ID" \
  --stage-name prod \
  --region "$REGION" >/dev/null

echo ""
echo "✅ API Gateway updated and deployed!"
echo ""
echo "Base URL: https://$API_ID.execute-api.$REGION.amazonaws.com/prod"
echo ""
echo "Configured endpoints:"
for ENDPOINT_SPEC in "${ENDPOINT_ARRAY[@]}"; do
  ENDPOINT_SPEC="${ENDPOINT_SPEC// /}"
  [ -z "$ENDPOINT_SPEC" ] && continue
  METHODS_STR="${ENDPOINT_SPEC%%:*}"
  PATH_SUFFIX="${ENDPOINT_SPEC#*:}"
  if [ "$PATH_SUFFIX" = "/" ]; then
    FULL_PATH="/api/$BASE_PATH"
  else
    FULL_PATH="/api/$BASE_PATH$PATH_SUFFIX"
  fi
  IFS=',' read -ra METHODS_ARRAY <<< "$METHODS_STR"
  for METHOD in "${METHODS_ARRAY[@]}"; do
    METHOD="${METHOD// /}"
    [ -z "$METHOD" ] && continue
    printf "  %-7s %s\n" "$METHOD" "$FULL_PATH"
  done
done
echo "  OPTIONS (all endpoints) - CORS preflight"
