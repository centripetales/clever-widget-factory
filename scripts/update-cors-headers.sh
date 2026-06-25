#!/bin/bash
# Update all OPTIONS mock integration responses to include X-Organization-Id in allowed headers
set -e

API_ID="0720au267k"
REGION="us-west-2"
NEW_HEADERS="'Content-Type,Authorization,X-Organization-Id,X-Connection-Id'"

# Get all resource IDs that have OPTIONS methods
RESOURCE_IDS=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --query 'items[*].{id:id,path:path,methods:resourceMethods}' --output json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data:
    methods = item.get('methods') or {}
    if 'OPTIONS' in methods:
        print(item['id'] + '|' + item['path'])
")

COUNT=0
UPDATED=0
SKIPPED=0
TOTAL=$(echo "$RESOURCE_IDS" | wc -l)

echo "Updating $TOTAL OPTIONS methods..."

while IFS='|' read -r RESOURCE_ID RESOURCE_PATH; do
  COUNT=$((COUNT + 1))
  
  OUTPUT=$(aws apigateway update-integration-response \
    --rest-api-id $API_ID \
    --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS \
    --status-code 200 \
    --patch-operations "[{\"op\":\"replace\",\"path\":\"/responseParameters/method.response.header.Access-Control-Allow-Headers\",\"value\":\"$NEW_HEADERS\"}]" \
    --region $REGION 2>&1) && {
    echo "[$COUNT/$TOTAL] ✅ $RESOURCE_PATH"
    UPDATED=$((UPDATED + 1))
  } || {
    echo "[$COUNT/$TOTAL] ⏭️  $RESOURCE_PATH (Lambda proxy, skipped)"
    SKIPPED=$((SKIPPED + 1))
  }
  
  sleep 0.5
done <<< "$RESOURCE_IDS"

echo ""
echo "Updated: $UPDATED, Skipped: $SKIPPED"
echo ""
echo "Deploying..."
aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod --region $REGION
echo "✅ Deployed!"
