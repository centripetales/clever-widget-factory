import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  return {
    base: process.env.VITE_BASE_PATH || '/',
  server: {
    host: "::",
    port: 8080,
    watch: {
      ignored: ['**/lambda/**', '**/scripts/**', '**/.kiro/**', '**/node_modules/**']
    }
  },
  plugins: [
    react(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // src/lib/expectations.ts imports a file from lambda/mcp-server, whose
    // own node_modules may also hold mathjs; bundle the app's copy only.
    dedupe: ['mathjs'],
  },
  define: {
    global: 'globalThis',
    // Set by GitHub Actions on every deploy; plain values when building anywhere else.
    __BUILD_NUMBER__: JSON.stringify(process.env.GITHUB_RUN_NUMBER ?? 'dev'),
    __BUILD_COMMIT__: JSON.stringify((process.env.GITHUB_SHA ?? '').slice(0, 7)),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  optimizeDeps: {
    exclude: ['pg']
  }
  };
});
