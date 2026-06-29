#!/bin/bash
set -e

# Deploy an API Gateway resource with automatic OPTIONS/CORS configuration
# Usage: ./deploy-api-resource.sh <resource-path> <http-methods> <lambda-name>
# Example: ./deploy-api-resource.sh /api/invite-user POST cwf-organization-lambda
# Example: ./deploy-api-resource.sh /api/new-endpoint "GET,POST,DELETE" cwf-core-lambda

if [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
  echo "Usage: $0 <resource-path> <http-methods> <lambda-name>"
  echo "  resource-path: e.g. /api/invite-user"
  echo "  http-methods:  comma-separated, e.g. GET,POST,DELETE"
  echo "  lambda-name:   e.g. cwf-organization-lambda"
  exit 1
fi

RESOURCE_PATH="$1"
METHODS="$2"
LAMBDA_NAME="$3"
REGION="us-west-2"
REST_API_ID="0720au267k"
ACCOUNT_ID="131745734428"
AUTHORIZER_ID="pjg8xs"
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
INTEGRATION_URI="arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations"
ALLOWED_HEADERS="Content-Type,Authorization,X-Organization-Id,X-Connection-Id"

echo "🔍 Looking up resource: ${RESOURCE_PATH}..."

# Find the resource ID by path
RESOURCE_ID=$(aws apigateway get-resources \
  --rest-api-id "$REST_API_ID" \
  --region "$REGION" \
  --query "items[?path=='${RESOURCE_PATH}'].id" \
  --output text)

if [ -z "$RESOURCE_ID" ] || [ "$RESOURCE_ID" = "None" ]; then
  echo "❌ Resource ${RESOURCE_PATH} not found. Creating..."
  
  # Extract parent path and path part
  PARENT_PATH=$(dirname "$RESOURCE_PATH")
  PATH_PART=$(basename "$RESOURCE_PATH")
  
  PARENT_ID=$(aws apigateway get-resources \
    --rest-api-id "$REST_API_ID" \
    --region "$REGION" \
    --query "items[?path=='${PARENT_PATH}'].id" \
    --output text)
  
  if [ -z "$PARENT_ID" ] || [ "$PARENT_ID" = "None" ]; then
    echo "❌ Parent resource ${PARENT_PATH} not found"
    exit 1
  fi
  
  RESOURCE_ID=$(aws apigateway create-resource \
    --rest-api-id "$REST_API_ID" \
    --parent-id "$PARENT_ID" \
    --path-part "$PATH_PART" \
    --region "$REGION" \
    --query 'id' --output text)
  
  echo "  ✅ Created resource: ${RESOURCE_ID}"
fi

echo "  Resource ID: ${RESOURCE_ID}"

# Configure each HTTP method
ALL_METHODS="${METHODS},OPTIONS"
IFS=',' read -ra METHOD_ARRAY <<< "$METHODS"
for METHOD in "${METHOD_ARRAY[@]}"; do
  METHOD=$(echo "$METHOD" | xargs) # trim whitespace
  echo "⚙️  Configuring ${METHOD}..."
  
  # Check if method already exists
  EXISTING=$(aws apigateway get-method \
    --rest-api-id "$REST_API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method "$METHOD" \
    --region "$REGION" 2>/dev/null && echo "exists" || echo "")
  
  if [ -z "$EXISTING" ]; then
    aws apigateway put-method \
      --rest-api-id "$REST_API_ID" \
      --resource-id "$RESOURCE_ID" \
      --http-method "$METHOD" \
      --authorization-type CUSTOM \
      --authorizer-id "$AUTHORIZER_ID" \
      --region "$REGION" > /dev/null
    echo "  ✅ Method created"
  else
    echo "  ⏭️  Method already exists"
  fi
  
  # Set up Lambda proxy integration
  aws apigateway put-integration \
    --rest-api-id "$REST_API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method "$METHOD" \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "$INTEGRATION_URI" \
    --region "$REGION" > /dev/null
  echo "  ✅ Integration → ${LAMBDA_NAME}"
done

# Configure OPTIONS for CORS preflight
echo "⚙️  Configuring OPTIONS (CORS)..."
EXISTING_OPTIONS=$(aws apigateway get-method \
  --rest-api-id "$REST_API_ID" \
  --resource-id "$RESOURCE_ID" \
  --http-method OPTIONS \
  --region "$REGION" 2>/dev/null && echo "exists" || echo "")

if [ -z "$EXISTING_OPTIONS" ]; then
  aws apigateway put-method \
    --rest-api-id "$REST_API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS \
    --authorization-type NONE \
    --region "$REGION" > /dev/null
fi

aws apigateway put-integration \
  --rest-api-id "$REST_API_ID" \
  --resource-id "$RESOURCE_ID" \
  --http-method OPTIONS \
  --type MOCK \
  --request-templates '{"application/json": "{\"statusCode\": 200}"}' \
  --region "$REGION" > /dev/null

aws apigateway put-method-response \
  --rest-api-id "$REST_API_ID" \
  --resource-id "$RESOURCE_ID" \
  --http-method OPTIONS \
  --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Headers":false,"method.response.header.Access-Control-Allow-Methods":false,"method.response.header.Access-Control-Allow-Origin":false}' \
  --region "$REGION" > /dev/null 2>&1 || true

aws apigateway put-integration-response \
  --rest-api-id "$REST_API_ID" \
  --resource-id "$RESOURCE_ID" \
  --http-method OPTIONS \
  --status-code 200 \
  --response-parameters "{\"method.response.header.Access-Control-Allow-Headers\":\"'${ALLOWED_HEADERS}'\",\"method.response.header.Access-Control-Allow-Methods\":\"'${ALL_METHODS}'\",\"method.response.header.Access-Control-Allow-Origin\":\"'*'\"}" \
  --region "$REGION" > /dev/null

echo "  ✅ OPTIONS/CORS configured"

# Add Lambda invoke permission for API Gateway (idempotent)
echo "🔐 Ensuring Lambda invoke permission..."
aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --statement-id "apigateway-${RESOURCE_ID}-invoke" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${REST_API_ID}/*/*/*" \
  --region "$REGION" 2>/dev/null || true

# Deploy to prod
echo "🚀 Deploying to prod stage..."
aws apigateway create-deployment \
  --rest-api-id "$REST_API_ID" \
  --stage-name prod \
  --region "$REGION" > /dev/null

echo "✅ Done! ${RESOURCE_PATH} deployed with methods: ${ALL_METHODS}"
