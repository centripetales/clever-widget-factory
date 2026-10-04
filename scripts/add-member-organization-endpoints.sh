#!/bin/bash
# API Gateway routes for member organizations (served by cwf-core-lambda).
# Idempotent: re-running skips resources/methods that already exist.
# Afterwards deploy the API:
#   aws apigateway create-deployment --rest-api-id 0720au267k --stage-name prod --region us-west-2

set -e
cd "$(dirname "$0")"
L=cwf-core-lambda

./add-api-endpoint.sh "/api/organizations/{id}/member-organizations" OPTIONS $L
./add-api-endpoint.sh "/api/organizations/{id}/member-organizations" GET $L
./add-api-endpoint.sh "/api/organizations/{id}/member-organizations" POST $L
./add-api-endpoint.sh "/api/organizations/{id}/member-organizations/{memberOrgId}" OPTIONS $L
./add-api-endpoint.sh "/api/organizations/{id}/member-organizations/{memberOrgId}" DELETE $L
