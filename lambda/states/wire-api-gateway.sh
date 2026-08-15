#!/bin/bash
set -e

API_ID="0720au267k"
REGION="us-west-2"
AUTHORIZER_ID="pjg8xs"
# :live alias, not the bare function — cwf-states-lambda is onboarded to the
# versioned-alias deploy pattern (see scripts/deploy/README.md). Wiring a new
# route to the unqualified ARN would silently invoke $LATEST instead, bypassing
# the alias and breaking the assumption that rollback-lambda.sh controls what's live.
LAMBDA_ARN="arn:aws:lambda:us-west-2:131745734428:function:cwf-states-lambda:live"

echo "🔧 Setting up API Gateway routes for states..."

# Get all resources
RESOURCES=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --output json)

# Function to create resource if it doesn't exist
create_resource_if_needed() {
  local PATH_ARG=$1
  local PARENT_PATH=$(dirname "$PATH_ARG")
  local RESOURCE_NAME=$(basename "$PATH_ARG")
  
  # Check if resource exists
  RESOURCE_ID=$(echo $RESOURCES | jq -r ".items[] | select(.path == \"$PATH_ARG\") | .id")
  
  if [ -z "$RESOURCE_ID" ]; then
    echo "  Creating resource $PATH_ARG..." >&2
    
    # Get parent resource ID
    if [ "$PARENT_PATH" = "/api" ]; then
      PARENT_ID=$(echo $RESOURCES | jq -r '.items[] | select(.path == "/api") | .id')
    else
      PARENT_ID=$(echo $RESOURCES | jq -r ".items[] | select(.path == \"$PARENT_PATH\") | .id")
    fi
    
    RESOURCE_ID=$(aws apigateway create-resource \
      --rest-api-id $API_ID \
      --parent-id $PARENT_ID \
      --path-part "$RESOURCE_NAME" \
      --region $REGION \
      --query 'id' --output text)
    
    echo "  ✅ Created resource: $RESOURCE_ID" >&2
  else
    echo "  ✅ Resource exists: $RESOURCE_ID" >&2
  fi
  
  echo $RESOURCE_ID
}

# Function to add method with authorizer
add_method() {
  local RESOURCE_ID=$1
  local METHOD=$2
  
  echo "    Calling put-method for $METHOD..."
  aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $METHOD \
    --authorization-type CUSTOM \
    --authorizer-id $AUTHORIZER_ID \
    --region $REGION 2>&1 || echo "    ⚠️  Error adding method"
}

# Function to add OPTIONS method for CORS
add_options_method() {
  local RESOURCE_ID=$1
  
  # Add OPTIONS method (no auth)
  aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --authorization-type NONE \
    --region $REGION > /dev/null 2>&1 || true
  
  # Add MOCK integration
  aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --type MOCK \
    --request-templates '{"application/json": "{\"statusCode\": 200}"}' \
    --region $REGION > /dev/null 2>&1 || true
  
  # Add method response
  aws apigateway put-method-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":false,"method.response.header.Access-Control-Allow-Methods":false,"method.response.header.Access-Control-Allow-Origin":false}' \
    --region $REGION > /dev/null 2>&1 || true
  
  # Add integration response with CORS headers
  aws apigateway put-integration-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":"'"'"'Content-Type,Authorization'"'"'","method.response.header.Access-Control-Allow-Methods":"'"'"'GET,POST,PUT,DELETE,OPTIONS'"'"'","method.response.header.Access-Control-Allow-Origin":"'"'"'*'"'"'"}' \
    --region $REGION > /dev/null 2>&1 || true
}

# Function to add Lambda integration
add_integration() {
  local RESOURCE_ID=$1
  local METHOD=$2
  
  echo "    Calling put-integration for $METHOD..."
  aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $METHOD \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations" \
    --region $REGION 2>&1 || echo "    ⚠️  Error adding integration"
}

# Setup /api/states
echo ""
echo "📍 Setting up /api/states..."
RESOURCE_ID=$(create_resource_if_needed "/api/states")

for METHOD in GET POST PUT DELETE; do
  echo "  Adding $METHOD method..."
  add_method $RESOURCE_ID $METHOD
  add_integration $RESOURCE_ID $METHOD
  echo "  ✅ $METHOD configured"
done

echo "  Adding OPTIONS for CORS..."
add_options_method $RESOURCE_ID
echo "  ✅ OPTIONS configured"

# Setup /api/states/{id} if needed
echo ""
echo "📍 Setting up /api/states/{id}..."
RESOURCE_ID=$(create_resource_if_needed "/api/states/{id}")

for METHOD in GET PUT DELETE; do
  echo "  Adding $METHOD method..."
  add_method $RESOURCE_ID $METHOD
  add_integration $RESOURCE_ID $METHOD
  echo "  ✅ $METHOD configured"
done

echo "  Adding OPTIONS for CORS..."
add_options_method $RESOURCE_ID
echo "  ✅ OPTIONS configured"

# Deploy changes
echo ""
echo "🚀 Deploying API Gateway..."
aws apigateway create-deployment \
  --rest-api-id $API_ID \
  --stage-name prod \
  --region $REGION > /dev/null

echo ""
echo "✅ API Gateway updated and deployed!"
echo ""
echo "Test with:"
echo "  curl https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/states"
echo ""
echo "Endpoints configured:"
echo "  GET    /api/states          - List states (with filters)"
echo "  POST   /api/states          - Create state"
echo "  GET    /api/states/{id}     - Get state by ID"
echo "  PUT    /api/states/{id}     - Update state"
echo "  DELETE /api/states/{id}     - Delete state"
echo "  OPTIONS (all endpoints)     - CORS preflight"
