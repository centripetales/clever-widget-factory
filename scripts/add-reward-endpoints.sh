#!/bin/bash
# API Gateway routes for action rewards (served by cwf-actions-lambda).
# Idempotent: re-running skips resources/methods that already exist.
# Afterwards deploy the API:
#   aws apigateway create-deployment --rest-api-id 0720au267k --stage-name prod --region us-west-2

set -e
cd "$(dirname "$0")"
L=cwf-actions-lambda

./add-api-endpoint.sh "/api/actions/{id}/reward" OPTIONS $L
./add-api-endpoint.sh "/api/actions/{id}/reward" GET $L
./add-api-endpoint.sh "/api/actions/{id}/reward" POST $L
