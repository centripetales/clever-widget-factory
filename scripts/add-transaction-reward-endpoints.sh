#!/bin/bash
# API Gateway routes for rewards from a transaction (served by cwf-actions-lambda).
# add-api-endpoint.sh creates one path level at a time, so parents come first;
# /api/financial-records/{id} and /api/positive-sum already exist.
# Idempotent: re-running skips resources/methods that already exist.
# Afterwards deploy the API:
#   aws apigateway create-deployment --rest-api-id 0720au267k --stage-name prod --region us-west-2

set -e
cd "$(dirname "$0")"
L=cwf-actions-lambda

./add-api-endpoint.sh "/api/financial-records/{id}/action" OPTIONS $L
./add-api-endpoint.sh "/api/financial-records/{id}/action" GET $L
./add-api-endpoint.sh "/api/financial-records/{id}/action" POST $L
./add-api-endpoint.sh "/api/financial-records/{id}/action/draft" OPTIONS $L
./add-api-endpoint.sh "/api/financial-records/{id}/action/draft" POST $L

./add-api-endpoint.sh /api/positive-sum/organizations OPTIONS $L
./add-api-endpoint.sh /api/positive-sum/organizations GET $L
./add-api-endpoint.sh /api/positive-sum/organizations POST $L
