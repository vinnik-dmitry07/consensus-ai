import { env } from 'node:process';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: env.VITE_BASE || '/',
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.js'],
    fileParallelism: false,
  },
});
