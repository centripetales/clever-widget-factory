# API Documentation Update Hook

## Trigger Conditions

Run this hook when:
- Lambda functions are deployed or modified
- API Gateway endpoints are added/changed
- User explicitly requests API docs update
- PR preparation phase (agent can suggest if Lambda changes detected)

## Hook Actions

1. **Detect if API update needed**
   - Check git diff for `lambda/*/wire-api-gateway.sh` execution
   - Check for new Lambda deployments
   - Ask user: "I noticed API changes. Should I update the API documentation?"

2. **Export OpenAPI spec from API Gateway**
   ```bash
   aws apigateway get-export \
     --rest-api-id 0720au267k \
     --stage-name prod \
     --export-type oas30 \
     --accepts application/yaml \
     --region us-west-2 \
     docs/api/openapi.yaml
   ```

3. **Verify output**
   - Check if file was generated successfully
   - Verify YAML syntax is valid
   - Count endpoints and compare with previous version
   - Report what changed (new endpoints, removed endpoints)

4. **Add to PR with context**
   - Stage the file: `git add docs/api/openapi.yaml`
   - Provide explanation: "Updated API docs - added [X] endpoints, modified [Y]"
   - Include link to view docs

5. **Provide documentation link**
   ```
   📚 View API Documentation:
   https://editor.swagger.io/?url=https://raw.githubusercontent.com/YOUR_ORG/clever-widget-factory/main/docs/api/openapi.yaml
   
   Or paste contents into: https://editor.swagger.io/
   ```

## Error Handling

If export fails:
- Check AWS credentials are configured
- Verify API Gateway ID is correct (0720au267k)
- Ensure user has apigateway:GET permissions
- Suggest manual export for debugging

## Manual Override

User can always run manually:
```bash
aws apigateway get-export \
  --rest-api-id 0720au267k \
  --stage-name prod \
  --export-type oas30 \
  --accepts application/yaml \
  --region us-west-2 \
  docs/api/openapi.yaml
```

## Combined with Schema Update

This hook can run together with database schema update:
- Database schema changes → Update `docs/architecture/DATABASE_SCHEMA.md`
- API endpoint changes → Update `docs/api/openapi.yaml`
- Both in same PR for complete documentation

## Benefits

- **Always current**: API docs match deployed endpoints
- **Reviewable**: Changes go through PR process
- **Discoverable**: Developers can see API changes in diffs
- **Standard format**: OpenAPI is industry standard
- **Interactive**: Can view in Swagger UI or Redoc
