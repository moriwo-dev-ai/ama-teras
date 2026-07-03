import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../shared/types';

const DEFAULTS: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
};

/** 設定の永続化。electron非依存(テスト可能にするためファイルパスを注入) */
export class ConfigStore {
  private config: AppConfig;

  constructor(private readonly filePath: string) {
    this.config = this.read();
  }

  private read(): AppConfig {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return structuredClone(DEFAULTS);
      const auto = (raw as Record<string, unknown>)['autoApprove'];
      const merged = structuredClone(DEFAULTS);
      if (typeof auto === 'object' && auto !== null) {
        for (const key of ['safe', 'write', 'exec'] as const) {
          const v = (auto as Record<string, unknown>)[key];
          if (typeof v === 'boolean') merged.autoApprove[key] = v;
        }
      }
      return merged;
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  get(): AppConfig {
    return structuredClone(this.config);
  }

  set(next: AppConfig): AppConfig {
    this.config = structuredClone(next);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    return this.get();
  }
}
