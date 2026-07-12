import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '*.config.js',
        'coverage/',
        '*.test.js',
        '__tests__/',
        '__mocks__/',
        'vitest.setup.js',
      ]
    }
  }
});
