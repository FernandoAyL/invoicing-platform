import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vite dev server proxies /api to the backend so the frontend can call
// same-origin `/api/*` paths with `credentials: 'include'` and never touch
// the httpOnly session cookie directly. In docker-compose this is set to
// http://app:8080 (the api container's service name); locally it defaults
// to the api's default port.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind all interfaces so the dev server is reachable from outside its
    // container (docker-compose's `web` service maps 5173 to the host).
    host: true,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
