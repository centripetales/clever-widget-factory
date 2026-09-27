/**
 * Integration Test Configuration
 * 
 * Configuration for testing against real Lambda endpoints with authentication
 */

export interface IntegrationTestConfig {
  lambdaEndpoint: string;
  testDatabase: string;
  cleanupStrategy: 'auto' | 'manual';
  timeoutMs: number;
  maxRetries: number;
  testDataPrefix: string;
  authConfig: {
    username: string;
    password: string;
    userPoolId: string;
    userPoolClientId: string;
    region: string;
  };
}

export interface TestActionData {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  required_tools?: string[];
  assigned_to?: string;
  created_at: string;
  updated_at: string;
}

export interface TestToolData {
  id: string;
  name: string;
  status: 'available' | 'maintenance' | 'retired';
}

// Default configuration for integration tests
export const defaultIntegrationConfig: IntegrationTestConfig = {
  lambdaEndpoint: process.env.VITE_API_BASE_URL || 'http://localhost:3000',
  testDatabase: 'test',
  cleanupStrategy: 'auto',
  timeoutMs: 30000, // 30 seconds for real API calls
  maxRetries: 3,
  testDataPrefix: 'integration-test-',
  authConfig: {
    username: process.env.INTEGRATION_TEST_USERNAME || 'integration-test-user',
    password: process.env.INTEGRATION_TEST_PASSWORD || 'TempPassword123!',
    userPoolId: process.env.VITE_AWS_COGNITO_USER_POOL_ID || '',
    userPoolClientId: process.env.VITE_AWS_COGNITO_CLIENT_ID || process.env.VITE_USER_POOL_CLIENT_ID || '',
    region: process.env.VITE_AWS_REGION || 'us-west-2'
  }
};

// Test environment detection
export const isIntegrationTestEnvironment = (): boolean => {
  return process.env.NODE_ENV === 'test' && process.env.INTEGRATION_TESTS === 'true';
};

// Check if authentication is properly configured
export const isAuthConfigured = (): boolean => {
  const config = defaultIntegrationConfig.authConfig;
  return !!(
    config.username &&
    config.password &&
    config.userPoolId &&
    config.userPoolClientId &&
    config.region
  );
};

// Skip integration tests if not in proper environment
export const skipIfNotIntegrationEnv = () => {
  if (!isIntegrationTestEnvironment()) {
    console.log('Skipping integration tests - set INTEGRATION_TESTS=true to run');
    return true;
  }
  
  if (!isAuthConfigured()) {
    console.log('Skipping integration tests - authentication not configured');
    console.log('Run: node scripts/setup-test-user.js to set up test authentication');
    return true;
  }
  
  return false;
};