import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes to dist/ (matches the SWA outputLocation in Bicep).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
