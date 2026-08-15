# TanStack Actions Integration Testing

This directory contains comprehensive integration tests for the TanStack Actions enhancement, validating the implementation against real Lambda endpoints to ensure production-ready reliability.

## Overview

The integration testing framework validates all 12 correctness properties (Properties 1-12) with real API endpoints, ensuring that:

- Optimistic updates work correctly with server responses
- Error handling and rollback mechanisms function properly
- Cache coordination remains consistent between client and server
- Tool checkout workflows operate correctly end-to-end
- Performance meets acceptable standards under various load conditions

## Test Structure

### Core Integration Tests

1. **Real API Validation** (`realApiValidation.test.tsx`)
   - Tests action creation and updates through actual Lambda endpoints
   - Verifies server-computed affected resources are properly cached
   - Validates response structure and data consistency

2. **Error Scenarios** (`errorScenarios.test.tsx`)
   - Tests actual validation errors from Lambda endpoints
   - Verifies proper rollback behavior with real server responses
   - Validates error classification and retry logic

3. **Tool Checkout Workflows** (`toolCheckoutWorkflows.test.tsx`)
   - Tests end-to-end action completion with tool assignments
   - Verifies tool checkout status updates through real API
   - Validates concurrent tool assignment handling

4. **Offline/Online Workflows** (`offlineOnlineWorkflows.test.tsx`)
   - Tests network disconnection and mutation queuing
   - Verifies proper execution order when connectivity restored
   - Validates offline-first architecture patterns

5. **Asset Checkout Validation** (`assetCheckoutValidation.test.tsx`)
   - Tests specific scenario where tools added to actions should show as checked out
   - Reproduces tool checkout issue using "Test Tool 1" to avoid conflicts with existing data
   - Validates Combined Assets view consistency with action tool assignments
   - Tests state persistence across page refreshes and different query methods

### Property-Based Integration Tests

**Property-Based Integration Tests** (`propertyBasedIntegration.test.tsx`)

- **Property 10: Real API Integration Consistency**
  - Server response data matches database state
  - Affected resources are properly computed and cached
  - Cache state remains consistent with server state

- **Property 11: Concurrent Mutation Coordination**
  - Mutations are properly serialized or handled concurrently
  - Final state is consistent across all clients
  - No race conditions cause data corruption

- **Property 12: Performance and Timing Accuracy**
  - Response times are within acceptable limits
  - Timing measurements are accurate
  - Performance doesn't degrade with concurrent operations

## Test Infrastructure

### Configuration (`config.ts`)
- Environment detection and test skipping logic
- Integration test environment validation
- API endpoint configuration

### Test Data Management (`testDataManager.ts`)
- Automated test data creation and cleanup
- Database isolation for parallel test execution
- Resource lifecycle management

### Network Simulation (`networkSimulator.ts`)
- Network condition simulation (offline/online)
- Latency and error injection
- Connection state management

## Running Integration Tests

### Prerequisites

Integration tests require proper authentication setup to work with real Lambda endpoints.

#### 1. Install Dependencies
```bash
npm install --save-dev @aws-sdk/client-cognito-identity-provider @aws-sdk/credential-providers
```

#### 2. Set Up Test User
```bash
# Create test user in Cognito
npm run setup:test-user

# Complete the generated .env.test file with your values
# Copy VITE_USER_POOL_CLIENT_ID and VITE_API_BASE_URL from your main .env
```

#### 3. Run Tests
```bash
# Run all integration tests
npm run test:integration

# Run specific test (like the asset checkout validation)
npm run test:integration -- assetCheckoutValidation.test.tsx
```

See [docs/architecture/INTEGRATION_TESTING.md](../../../docs/architecture/INTEGRATION_TESTING.md) for current setup instructions (this file has known drift, see that doc).

### Environment Variables

```bash
# Required for integration tests
INTEGRATION_TESTS=true
NODE_ENV=test
INTEGRATION_TEST_USERNAME=integration-test-user
INTEGRATION_TEST_PASSWORD=TempPassword123!
VITE_AWS_COGNITO_USER_POOL_ID=us-west-2_xxxxxxxxx
VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_API_BASE_URL=https://xxxxxxxxxx.execute-api.us-west-2.amazonaws.com/prod

# Optional test configuration
INTEGRATION_TEST_TIMEOUT=30000
INTEGRATION_TEST_RETRIES=3
INTEGRATION_TEST_PARALLEL=false
```

## Test Data Cleanup

The integration tests automatically manage test data lifecycle:

- **Setup**: Creates isolated test data before each test
- **Execution**: Uses dedicated test resources to avoid conflicts
- **Cleanup**: Automatically removes test data after each test
- **Isolation**: Each test runs with fresh, isolated data

### Manual Cleanup

If tests are interrupted and cleanup doesn't complete:

```bash
# Clean up test data manually
npm run test:cleanup

# Or use the test data manager directly
node -e "
const { TestDataManager } = require('./src/hooks/__tests__/integration/testDataManager.ts');
const manager = new TestDataManager();
manager.cleanupAllTestData().then(() => console.log('Cleanup complete'));
"
```

## Performance Benchmarks

The integration tests validate performance against these benchmarks:

### Response Time Limits
- **Single Mutation**: < 15 seconds maximum, < 10 seconds average
- **Concurrent Load**: < 25 seconds maximum, < 15 seconds average
- **Total Operations**: < 60 seconds for concurrent test suites

### Throughput Requirements
- **Minimum Throughput**: > 0.1 operations per second under load
- **Concurrent Operations**: Support 2-4 simultaneous mutations
- **Queue Processing**: Handle offline mutations within 30 seconds of reconnection

### Timing Accuracy
- **Debug Timing**: Within 1 second of actual measurement
- **Mutation Lifecycle**: All phases properly timed and logged
- **Cache Updates**: Non-blocking, < 100ms additional overhead

## Troubleshooting

### Common Issues

1. **Test Environment Not Available**
   ```
   Error: Integration test environment not configured
   ```
   - Ensure `INTEGRATION_TEST=true` is set
   - Verify `VITE_API_BASE_URL` points to accessible endpoint
   - Check network connectivity to test environment

2. **Database Connection Failures**
   ```
   Error: Failed to connect to test database
   ```
   - Verify database credentials and access
   - Check VPN connection if required
   - Ensure test database is running and accessible

3. **Lambda Endpoint Errors**
   ```
   Error: 500 Internal Server Error from Lambda
   ```
   - Check Lambda function deployment status
   - Verify API Gateway configuration
   - Review CloudWatch logs for Lambda errors

4. **Test Data Conflicts**
   ```
   Error: Test data already exists
   ```
   - Run manual cleanup: `npm run test:cleanup`
   - Check for orphaned test data from previous runs
   - Ensure test isolation is working correctly

### Debug Mode

Enable debug mode for detailed test execution logs:

```bash
# Enable debug logging
DEBUG=tanstack-actions:* npm run test:integration

# Enable verbose property-based test output
npm run test -- --reporter=verbose src/hooks/__tests__/integration/propertyBasedIntegration.test.tsx
```

### Performance Debugging

Monitor performance during test execution:

```bash
# Run with performance monitoring
PERFORMANCE_MONITOR=true npm run test:integration

# Generate performance report
npm run test:performance-report
```

## Maintenance

### Regular Maintenance Tasks

1. **Weekly**: Review test execution times and update benchmarks if needed
2. **Monthly**: Clean up any orphaned test data in staging environment
3. **Quarterly**: Review and update performance benchmarks based on infrastructure changes

### Updating Tests

When adding new features or modifying existing functionality:

1. **Update Property Tests**: Extend property-based tests to cover new scenarios
2. **Add Integration Tests**: Create specific integration tests for new endpoints
3. **Update Benchmarks**: Adjust performance expectations if architecture changes
4. **Review Cleanup**: Ensure new test data types are properly cleaned up

### Monitoring

The integration tests provide monitoring data for:

- **Test Execution Times**: Track performance trends over time
- **Failure Rates**: Monitor test stability and reliability
- **API Response Times**: Track backend performance changes
- **Error Patterns**: Identify recurring issues or regressions

This data can be integrated with CI/CD pipelines to catch performance regressions and ensure consistent quality.