import type { MyCodexApi } from '../shared/ipc';

declare global {
  interface Window {
    api: MyCodexApi;
  }
}

export {};
