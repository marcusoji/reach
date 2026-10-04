import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Must match the API's REACH_ALLOWED_ORIGINS default (and the deploy workflow's fallback):
    // the browser calls the Edge API cross-origin, so a port the API does not allow makes every
    // request after sign-in fail as an opaque "Failed to fetch".
    port: 5173,
    open: false,
  },
});
