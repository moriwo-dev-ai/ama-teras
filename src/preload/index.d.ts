import type { AmaterasApi } from '../shared/ipc';

declare global {
  interface Window {
    api: AmaterasApi;
  }
}

export {};
