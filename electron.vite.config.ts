import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    // esbuild等のネイティブ依存はバンドル不可。依存は実行時にnode_modulesから解決する
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // M173(C工事): world-serverはelectron非依存の独立プロセス(plain nodeで起動)
        input: {
          index: 'src/main/index.ts',
          'world-server': 'src/main/world-server.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // sandbox: true のレンダラで動かすため preload は CJS 固定
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
