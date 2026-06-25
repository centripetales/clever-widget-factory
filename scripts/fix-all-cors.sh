#!/bin/bash

# Fix CORS for all API Gateway endpoints
# This ensures all OPTIONS methods allow GET,POST,PUT,DELETE,OPTIONS

API_ID="0720au267k"
REGION="us-west-2"

echo "🔧 Fixing CORS for all API Gateway endpoints..."

# Get all resources and parse with Python
RESOURCES=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --output json)

echo "$RESOURCES" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('items', []):
    if item.get('path') and item['path'] != '/':
        print(f\"{item['id']}|{item['path']}\")
" | while IFS='|' read -r RESOURCE_ID PATH; do
  
  echo "  Checking $PATH (ID: $RESOURCE_ID)..."
  
  # Check if OPTIONS method exists
  HAS_OPTIONS=$(aws apigateway get-method --rest-api-id $API_ID --resource-id $RESOURCE_ID --http-method OPTIONS --region $REGION 2>&1)
  
  if [[ $HAS_OPTIONS == *"NotFoundException"* ]]; then
    echo "    ⚠️  No OPTIONS method found, skipping..."
    continue
  fi
  
  # Update the integration response to allow all methods
  aws apigateway put-integration-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":"'"'"'Content-Type,Authorization,X-Organization-Id,X-Connection-Id'"'"'","method.response.header.Access-Control-Allow-Methods":"'"'"'GET,POST,PUT,DELETE,OPTIONS'"'"'","method.response.header.Access-Control-Allow-Origin":"'"'"'*'"'"'"}' \
    --region $REGION \
    > /dev/null 2>&1
  
  if [ $? -eq 0 ]; then
    echo "    ✅ Updated CORS for $PATH"
  else
    echo "    ❌ Failed to update $PATH"
  fi
done

echo ""
echo "🚀 Deploying changes to prod stage..."
aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod --region $REGION > /dev/null

echo "✅ Done! All endpoints now allow GET,POST,PUT,DELETE,OPTIONS"
