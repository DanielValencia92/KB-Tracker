import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.json';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [
    crx({ manifest }),
  ],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
        dashboard: resolve(__dirname, 'src/dashboard/dashboard.html'),
      },
    },
    // Prevent mangling names that must survive JSON serialisation
    minify: false,
    sourcemap: true,
  },
});
