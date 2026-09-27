# Tool Creation Integration Test Setup

This document provides step-by-step instructions for setting up and running the tool creation integration tests.

## Overview

The tool creation integration test validates:
- ✅ **Authentication**: Test user can sign in to Cognito
- ✅ **Authorization**: Test user has proper database permissions
- ✅ **Tool Creation**: Can create tools through real Lambda API endpoints
- ✅ **Permission Validation**: Comprehensive permission boundary testing
- ✅ **Error Handling**: Provides clear diagnostics for permission issues

## Prerequisites

1. **Environment Variables**: Ensure your `.env.test` file is configured
2. **Database Access**: You need access to the development database
3. **AWS Credentials**: The Lambda endpoints must be accessible

## Setup Instructions

### Step 1: Verify Environment Configuration

Check that your `.env.test` file contains the correct values:

```bash
# Integration Test Environment Variables
INTEGRATION_TEST_USERNAME=integration-test@example.com
INTEGRATION_TEST_PASSWORD=TempPassword123!
INTEGRATION_TEST_EMAIL=integration-test@example.com

# AWS Configuration
VITE_AWS_COGNITO_USER_POOL_ID=us-west-2_84dcGaogx
VITE_AWS_COGNITO_CLIENT_ID=59nim1jiqcq7fuqvsu212a4f8f
VITE_AWS_REGION=us-west-2
VITE_API_BASE_URL=https://0720au267k.execute-api.us-west-2.amazonaws.com/prod

# Integration Test Configuration
INTEGRATION_TESTS=true
NODE_ENV=test
```

### Step 2: Set Database Password

The setup script needs access to the development database:

```bash
export DB_PASSWORD=your_database_password
```

### Step 3: Run Database Setup

Add the integration test user to the `organization_members` table:

```bash
./scripts/setup-integration-test-user.sh
```

This script will:
- Connect to the development database
- Check if the integration test user already exists
- Add the user to the first active organization with `contributor` role
- Verify the user was added successfully
- Show what permissions the `contributor` role grants

### Step 4: Run Integration Tests

```bash
# Run all integration tests
npm run test:integration

# Run only the tool creation integration test
npm run test src/hooks/__tests__/integration/toolCreationIntegration.test.tsx
```

## Expected Test Results

### ✅ Successful Test Run

When everything is set up correctly, you should see:

```
✅ Integration test setup complete
🔐 Testing user permissions...
✅ All permissions are working correctly!
🔧 Creating test tool: { name: 'Test Tool...', category: 'Test Equipment', status: 'available' }
✅ Test tool created successfully
🧹 Cleaning up 3 created test tools...
✅ Integration test cleanup complete

Test Files  1 passed (1)
Tests  13 passed (13)
```

### ❌ Common Issues and Solutions

#### Issue 1: Permission Denied (403 Forbidden)

**Error Message:**
```
❌ Tool creation permission: DENIED
Status: 403
Error: {"message":"Invalid key=value pair (missing equal-sign) in Authorization header..."}
```

**Solution:**
1. Set the database password: `export DB_PASSWORD=your_password`
2. Run the setup script: `./scripts/setup-integration-test-user.sh`
3. Verify the user was added to the database
4. Re-run the tests

#### Issue 2: Authentication Failed (401 Unauthorized)

**Error Message:**
```
❌ Failed to sign in test user: [AuthError]
```

**Solution:**
1. Verify the Cognito user exists in the user pool
2. Check that the username/password in `.env.test` are correct
3. Ensure the Cognito User Pool ID and Client ID are correct

#### Issue 3: Database Connection Failed

**Error Message:**
```
❌ ERROR: DB_PASSWORD environment variable is required
```

**Solution:**
1. Set the database password: `export DB_PASSWORD=your_password`
2. Ensure you have network access to the RDS instance
3. Verify the database host/port/credentials are correct

## Test Structure

The integration test is organized into several test suites:

### 1. Permission Validation
- Tests that the user has required `data:read` and `data:write` permissions
- Validates permission boundary enforcement
- Tests organization-scoped access

### 2. Tool Creation
- Tests creating tools with minimal data
- Tests creating tools with complete data
- Tests validation error handling

### 3. Error Handling and Diagnostics
- Tests that clear error messages are provided for permission issues
- Tests network error handling
- Tests actionable remediation suggestions

## Diagnostic Features

The integration test includes comprehensive diagnostic capabilities:

### Permission Diagnostic Report

When permission issues are detected, the test provides a detailed report:

```
📋 PERMISSION DIAGNOSTIC REPORT
================================
❌ GET /tools
   Expected: data:read
   Status: 403
   Error: [detailed error message]

❌ POST /tools
   Expected: data:write
   Status: 403
   Error: [detailed error message]

📝 RECOMMENDATIONS:
❌ Permission issues detected:
🚫 Authorization issue: User lacks required database permissions
   - Run: scripts/setup-integration-test-user.sh
   - Verify the user exists in organization_members table
   - Ensure the user has contributor, leadership, or admin role
   - Check that the user is in an active organization

🔧 To fix permission issues:
   1. Set DB_PASSWORD environment variable
   2. Run: ./scripts/setup-integration-test-user.sh
   3. Verify user was added to organization_members table
   4. Re-run the integration tests
```

### Automatic Cleanup

The test automatically cleans up all created resources:
- Test tools are marked as `removed` status
- Test actions are completed to release checked-out tools
- Authentication sessions are properly closed

## Database Schema Requirements

The integration test requires these database tables and permissions:

### Required Tables
- `organizations` - Must have at least one active organization
- `organization_members` - Test user must be added here
- `tools` - For tool creation and management

### Required Permissions
The test user needs `contributor` role which grants:
- `data:read` - Can read tools, actions, and other data
- `data:write` - Can create and update tools, actions, and other data

## Troubleshooting

### Debug Mode

To see detailed request/response logging, check the test output. The integration test logs:
- All API requests with full details
- Response status codes and bodies
- Timing information for performance analysis
- Complete error context with actionable remediation steps

### Manual Verification

You can manually verify the setup:

1. **Check Cognito User:**
   ```bash
   # The user should exist in the Cognito User Pool
   # Username: integration-test@example.com
   ```

2. **Check Database User:**
   ```sql
   SELECT cognito_user_id, full_name, role, is_active, organization_id
   FROM organization_members 
   WHERE cognito_user_id = 'integration-test@example.com';
   ```

3. **Test API Access:**
   ```bash
   # Should return 200 OK with tools data
   curl -H "Authorization: Bearer YOUR_TOKEN" \
        https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/tools
   ```

## Contributing

When modifying the integration tests:

1. **Maintain Cleanup**: Always ensure new tests clean up created resources
2. **Add Diagnostics**: Include helpful error messages and remediation suggestions
3. **Test Real Endpoints**: Use actual Lambda API endpoints, not mocks
4. **Document Changes**: Update this README when adding new test scenarios

## Related Files

- `src/hooks/__tests__/integration/testAuth.ts` - Authentication service
- `src/hooks/__tests__/integration/TestToolCreator.ts` - Tool creation utilities
- `src/hooks/__tests__/integration/PermissionValidator.ts` - Permission testing
- `scripts/setup-integration-test-user.sql` - Database setup script
- `scripts/setup-integration-test-user.sh` - Setup automation script