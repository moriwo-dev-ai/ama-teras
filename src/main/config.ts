import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../shared/types';

const DEFAULTS: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  // 後方互換: 既存ユーザーの設定ファイルに scopeMode が無くても従来挙動(project)になる
  scopeMode: 'project',
  // M10: リモートアクセスは既定で無効(有効化はデスクトップの設定UIからのみ)
  remote: { enabled: false, port: 8787 },
};

/** 設定の永続化。electron非依存(テスト可能にするためファイルパスを注入) */
export class ConfigStore {
  private config: AppConfig;

  constructor(private readonly filePath: string) {
    this.config = this.read();
  }

  private read(): AppConfig {
    const merged = structuredClone(DEFAULTS);
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return merged;
      const rec = raw as Record<string, unknown>;
      const auto = rec['autoApprove'];
      if (typeof auto === 'object' && auto !== null) {
        for (const key of ['safe', 'write', 'exec'] as const) {
          const v = (auto as Record<string, unknown>)[key];
          if (typeof v === 'boolean') merged.autoApprove[key] = v;
        }
      }
      if (rec['provider'] === 'anthropic' || rec['provider'] === 'openai') {
        merged.provider = rec['provider'];
      }
      if (typeof rec['model'] === 'string') merged.model = rec['model'];
      if (typeof rec['workspace'] === 'string' && rec['workspace'] !== '') merged.workspace = rec['workspace'];
      if (rec['scopeMode'] === 'project' || rec['scopeMode'] === 'fullPc') merged.scopeMode = rec['scopeMode'];
      const remote = rec['remote'];
      if (typeof remote === 'object' && remote !== null && merged.remote) {
        const r = remote as Record<string, unknown>;
        if (typeof r['enabled'] === 'boolean') merged.remote.enabled = r['enabled'];
        if (typeof r['port'] === 'number' && Number.isInteger(r['port']) && r['port'] > 0 && r['port'] < 65536) {
          merged.remote.port = r['port'];
        }
        // 平文トークンは保存しない(sha256 hex のみ受け入れる)
        if (typeof r['tokenHash'] === 'string' && /^[0-9a-f]{64}$/.test(r['tokenHash'])) {
          merged.remote.tokenHash = r['tokenHash'];
        }
      }
      return merged;
    } catch {
      return merged;
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
