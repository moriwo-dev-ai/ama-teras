import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * M10-4: スマホ用SPA(remote-ui)のビルド設定。renderer とは独立したビルドで、
 * window.api(preload)に一切依存しない。出力は out/remote-ui(RemoteServer が配信)。
 * 開発時は `npm run dev:remote-ui` で vite dev サーバ + /api プロキシを使う。
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(here, '../../out/remote-ui'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        // SSE をプロキシできるように
        ws: false,
      },
    },
  },
});
