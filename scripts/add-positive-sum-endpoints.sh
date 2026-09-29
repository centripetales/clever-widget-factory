#!/bin/bash
# API Gateway routes for Positive Sum (served by cwf-actions-lambda).
# add-api-endpoint.sh creates one path level at a time, so parents come first.
# Idempotent: re-running skips resources/methods that already exist.
# Afterwards deploy the API:
#   aws apigateway create-deployment --rest-api-id 0720au267k --stage-name prod --region us-west-2

set -e
cd "$(dirname "$0")"
L=cwf-actions-lambda

./add-api-endpoint.sh /api/positive-sum OPTIONS $L
for path in goals policies options opportunities mine; do
  ./add-api-endpoint.sh /api/positive-sum/$path OPTIONS $L
done
./add-api-endpoint.sh /api/positive-sum/goals POST $L
./add-api-endpoint.sh /api/positive-sum/policies POST $L
./add-api-endpoint.sh /api/positive-sum/options POST $L
./add-api-endpoint.sh /api/positive-sum/opportunities GET $L
./add-api-endpoint.sh /api/positive-sum/mine GET $L

./add-api-endpoint.sh "/api/positive-sum/options/{id}" OPTIONS $L
for verb in join approve pass; do
  ./add-api-endpoint.sh "/api/positive-sum/options/{id}/$verb" OPTIONS $L
  ./add-api-endpoint.sh "/api/positive-sum/options/{id}/$verb" POST $L
done

./add-api-endpoint.sh /api/positive-sum/actions OPTIONS $L
./add-api-endpoint.sh "/api/positive-sum/actions/{id}" OPTIONS $L
./add-api-endpoint.sh "/api/positive-sum/actions/{id}/evidence" OPTIONS $L
./add-api-endpoint.sh "/api/positive-sum/actions/{id}/evidence" GET $L
