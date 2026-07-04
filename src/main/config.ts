import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../shared/types';

/** M11-1: maxTurns のクランプ範囲。未設定はループ側の既定(30)に委ねる */
export const MAX_TURNS_MIN = 1;
export const MAX_TURNS_MAX = 200;

export function clampMaxTurns(value: number): number {
  return Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, Math.round(value)));
}

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
      // M11-1: 数値でない・非有限の maxTurns は未設定として扱う(後方互換)
      if (typeof rec['maxTurns'] === 'number' && Number.isFinite(rec['maxTurns'])) {
        merged.maxTurns = clampMaxTurns(rec['maxTurns']);
      }
      // M11-4: 空文字の postEditHook は未設定(無効)として扱う
      if (typeof rec['postEditHook'] === 'string' && rec['postEditHook'].trim() !== '') {
        merged.postEditHook = rec['postEditHook'];
      }
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
    const clone = structuredClone(next);
    // M11-1: 保存時にもクランプして正規化する(UI・IPC経由の範囲外値を防ぐ)
    if (clone.maxTurns !== undefined) {
      if (Number.isFinite(clone.maxTurns)) clone.maxTurns = clampMaxTurns(clone.maxTurns);
      else delete clone.maxTurns;
    }
    // M11-4: 空文字は「無効化」= 未設定に正規化する
    if (clone.postEditHook !== undefined && clone.postEditHook.trim() === '') {
      delete clone.postEditHook;
    }
    this.config = clone;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    return this.get();
  }
}
