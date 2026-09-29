#!/bin/bash
# Add API Gateway endpoint with authorizer
# Usage: ./scripts/add-api-endpoint.sh <path> <method> [lambda_function]
# Example: ./scripts/add-api-endpoint.sh /api/analytics/observations GET cwf-analytics-lambda

set -e

API_ID="0720au267k"
REGION="us-west-2"
AUTHORIZER_ID="pjg8xs"

PATH_ARG="${1}"
METHOD="${2:-GET}"
LAMBDA_FUNCTION="${3:-cwf-core-lambda}"

if [ -z "$PATH_ARG" ]; then
  echo "Usage: $0 <path> <method> [lambda_function]"
  echo "Example: $0 /api/analytics/observations GET cwf-analytics-lambda"
  exit 1
fi

# Get Lambda ARN
LAMBDA_ARN=$(aws lambda get-function \
  --function-name $LAMBDA_FUNCTION \
  --region $REGION \
  --query 'Configuration.FunctionArn' \
  --output text)

echo "Lambda ARN: $LAMBDA_ARN"

# Get parent resource ID
PARENT_PATH=$(dirname "$PATH_ARG")
RESOURCE_NAME=$(basename "$PATH_ARG")

if [ "$PARENT_PATH" = "/api" ]; then
  PARENT_ID=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --query "items[?path=='/api'].id" --output text)
else
  PARENT_ID=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --query "items[?path=='$PARENT_PATH'].id" --output text)
fi

# Check if resource exists
RESOURCE_ID=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --query "items[?path=='$PATH_ARG'].id" --output text)

if [ -z "$RESOURCE_ID" ]; then
  echo "Creating resource $PATH_ARG..."
  RESOURCE_ID=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $PARENT_ID \
    --path-part "$RESOURCE_NAME" \
    --region $REGION \
    --query 'id' --output text)
fi

echo "Resource ID: $RESOURCE_ID"

# Add method with authorizer (skip OPTIONS)
if [ "$METHOD" != "OPTIONS" ]; then
  echo "Adding $METHOD method with authorizer..."
  aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $METHOD \
    --authorization-type CUSTOM \
    --authorizer-id $AUTHORIZER_ID \
    --region $REGION || echo "Method already exists"
else
  echo "Adding OPTIONS method (no auth)..."
  aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --authorization-type NONE \
    --region $REGION || echo "Method already exists"
fi

# Add integration
if [ "$METHOD" = "OPTIONS" ]; then
  echo "Adding MOCK integration for CORS..."
  aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --type MOCK \
    --request-templates '{"application/json": "{\"statusCode\": 200}"}' \
    --region $REGION || echo "Integration already exists"
  
  # Add method response
  aws apigateway put-method-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":false,"method.response.header.Access-Control-Allow-Methods":false,"method.response.header.Access-Control-Allow-Origin":false}' \
    --region $REGION 2>/dev/null || echo "Method response already exists"
  
  # Add integration response with CORS headers
  aws apigateway put-integration-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":"'"'"'Content-Type,Authorization,X-Organization-Id,X-Connection-Id'"'"'","method.response.header.Access-Control-Allow-Methods":"'"'"'GET,POST,PUT,DELETE,OPTIONS'"'"'","method.response.header.Access-Control-Allow-Origin":"'"'"'*'"'"'"}' \
    --region $REGION 2>/dev/null || echo "Integration response already exists"
else
  echo "Adding Lambda integration..."
  aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $METHOD \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:$REGION:lambda:path/2015-03-31/functions/$LAMBDA_ARN/invocations" \
    --region $REGION || echo "Integration already exists"
fi

# Add Lambda permission (skip for OPTIONS since it uses MOCK)
if [ "$METHOD" != "OPTIONS" ]; then
  echo "Adding Lambda permission..."
  
  # Add a broad wildcard permission so API Gateway can invoke this Lambda for any route.
  # Per-method permissions with path parameters ({id}) can fail silently, so this is the safety net.
  BROAD_STATEMENT_ID="apigateway-invoke-all"
  aws lambda add-permission \
    --function-name $LAMBDA_FUNCTION \
    --statement-id $BROAD_STATEMENT_ID \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:*:$API_ID/*" \
    --region $REGION 2>/dev/null || echo "Permission already exists"
fi

echo "✅ Done! Deploy with: aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod --region $REGION"
