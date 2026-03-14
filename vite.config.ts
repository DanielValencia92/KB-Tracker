import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import manifestJson from './src/manifest.json';
import { resolve } from 'path';

const target = (process.env.TARGET ?? 'chrome') as 'chrome' | 'firefox';

// Chrome MV3 uses `background.service_worker` (string).
// Firefox MV3 uses `background.scripts` (array) — same script, different field name.
function buildManifest() {
  if (target === 'firefox') {
    const { background, key: _key, permissions, ...rest } = manifestJson as Record<string, unknown> & {
      background: { service_worker: string; type: string };
      key?: string;
      permissions: string[];
    };
    return {
      ...rest,
      // Firefox doesn't support the chrome.identity API, so strip that permission
      permissions: (permissions ?? []).filter((p: string) => p !== 'identity'),
      background: {
        scripts: [background.service_worker],
        type: background.type,
      },
    };
  }
  return manifestJson;
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [
    webExtension({
      manifest: buildManifest,
      // dashboard.html and auth.html are opened via runtime.getURL so they are
      // not in the manifest; declare them here so the bundler includes them.
      additionalInputs: ['src/dashboard/dashboard.html', 'src/auth/auth.html'],
      browser: target,
    }),
    viteStaticCopy({
      targets: [{ src: 'assets/*', dest: 'assets' }],
    }),
  ],
  build: {
    outDir: target === 'firefox' ? 'dist-firefox' : 'dist-chrome',
    // Prevent mangling names that must survive JSON serialisation
    minify: false,
    sourcemap: true,
  },
});
