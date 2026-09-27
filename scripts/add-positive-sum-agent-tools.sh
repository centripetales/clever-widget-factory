#!/bin/bash
# Register the Positive Sum tools (getGoalContext, createOption) with Maxwell.
# The tools are served by cwf-actions-lambda (lambda/actions/agentEvent.js);
# schema: lambda/actions/positive-sum-openapi.json.
#
# 1. Let Bedrock (Maxwell only) invoke cwf-actions-lambda
# 2. Add the PositiveSum action group to the DRAFT agent and prepare it
# 3. Publish a new version and move the production + sonnet-deep aliases to it
# Rollback: point both aliases back to the previous version printed below.

set -e
REGION=us-west-2
ACCOUNT=131745734428
AGENT_ID=CNV04Q1OAZ
LAMBDA=cwf-actions-lambda
SCHEMA="$(cd "$(dirname "$0")/.." && pwd)/lambda/actions/positive-sum-openapi.json"
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$LAMBDA"

echo "Previous versions: production=$(aws bedrock-agent get-agent-alias --agent-id $AGENT_ID --agent-alias-id EOLN5DJPW4 --region $REGION --query 'agentAlias.routingConfiguration[0].agentVersion' --output text), sonnet-deep=$(aws bedrock-agent get-agent-alias --agent-id $AGENT_ID --agent-alias-id XVS45ZMCA6 --region $REGION --query 'agentAlias.routingConfiguration[0].agentVersion' --output text)"

aws lambda add-permission --function-name $LAMBDA --statement-id bedrock-agent-invoke \
  --action lambda:InvokeFunction --principal bedrock.amazonaws.com \
  --source-arn "arn:aws:bedrock:$REGION:$ACCOUNT:agent/$AGENT_ID" --region $REGION >/dev/null \
  || echo "Permission already exists"

EXISTING=$(aws bedrock-agent list-agent-action-groups --agent-id $AGENT_ID --agent-version DRAFT --region $REGION \
  --query "actionGroupSummaries[?actionGroupName=='PositiveSum'].actionGroupId" --output text)
if [ -z "$EXISTING" ]; then
  aws bedrock-agent create-agent-action-group --agent-id $AGENT_ID --agent-version DRAFT \
    --action-group-name PositiveSum --action-group-executor lambda=$LAMBDA_ARN \
    --api-schema "payload=$(cat "$SCHEMA" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)))')" \
    --description "Shape and save options for Positive Sum goals" --region $REGION >/dev/null
  echo "Created PositiveSum action group"
else
  aws bedrock-agent update-agent-action-group --agent-id $AGENT_ID --agent-version DRAFT --action-group-id $EXISTING \
    --action-group-name PositiveSum --action-group-executor lambda=$LAMBDA_ARN \
    --api-schema "payload=$(cat "$SCHEMA" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)))')" \
    --description "Shape and save options for Positive Sum goals" --region $REGION >/dev/null
  echo "Updated PositiveSum action group"
fi

aws bedrock-agent prepare-agent --agent-id $AGENT_ID --region $REGION >/dev/null
until [ "$(aws bedrock-agent get-agent --agent-id $AGENT_ID --region $REGION --query agent.agentStatus --output text)" = "PREPARED" ]; do sleep 3; done
echo "Agent prepared"

# Updating an alias without routing config publishes a new version from DRAFT.
aws bedrock-agent update-agent-alias --agent-id $AGENT_ID --agent-alias-id EOLN5DJPW4 --agent-alias-name production --region $REGION >/dev/null
until [ "$(aws bedrock-agent get-agent-alias --agent-id $AGENT_ID --agent-alias-id EOLN5DJPW4 --region $REGION --query agentAlias.agentAliasStatus --output text)" = "PREPARED" ]; do sleep 3; done
NEW_VERSION=$(aws bedrock-agent get-agent-alias --agent-id $AGENT_ID --agent-alias-id EOLN5DJPW4 --region $REGION --query 'agentAlias.routingConfiguration[0].agentVersion' --output text)
aws bedrock-agent update-agent-alias --agent-id $AGENT_ID --agent-alias-id XVS45ZMCA6 --agent-alias-name sonnet-deep \
  --routing-configuration agentVersion=$NEW_VERSION --region $REGION >/dev/null
echo "production and sonnet-deep now on version $NEW_VERSION"
