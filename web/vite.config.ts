import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/app': process.env.MASTRA_DEV_URL ?? 'http://localhost:4111',
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist-web', import.meta.url)),
    emptyOutDir: true,
  },
});
