import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig, ModelBand, ModelPolicy, ReviewGateConfig } from '../shared/types';

/** M11-1: maxTurns のクランプ範囲。未設定はループ側の既定(30)に委ねる */
export const MAX_TURNS_MIN = 1;
export const MAX_TURNS_MAX = 200;

export function clampMaxTurns(value: number): number {
  return Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, Math.round(value)));
}

/** M18: 格上げ回数のクランプ(0=格上げ無効〜3) */
export const MAX_ESCALATIONS_MAX = 3;

function parseBand(raw: unknown): ModelBand | null {
  const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!rec) return null;
  if (rec['provider'] !== 'anthropic' && rec['provider'] !== 'openai') return null;
  if (typeof rec['model'] !== 'string') return null;
  return { provider: rec['provider'], model: rec['model'] };
}

/** M19: レビュー閾値・回数のクランプ範囲 */
export const REVIEW_THRESHOLD_MIN = 1;
export const REVIEW_THRESHOLD_MAX = 5;
export const REVIEW_ROUNDS_MAX = 5;
export const REVIEW_DEFAULT_THRESHOLD = 4.0;
export const REVIEW_DEFAULT_ROUNDS = 2;

/** M19: reviewGate の読み込みバリデーション。形が崩れていたら未設定(=無効)として扱う */
export function parseReviewGate(raw: unknown): ReviewGateConfig | null {
  const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!rec || typeof rec['enabled'] !== 'boolean') return null;
  const threshold =
    typeof rec['threshold'] === 'number' && Number.isFinite(rec['threshold'])
      ? Math.min(REVIEW_THRESHOLD_MAX, Math.max(REVIEW_THRESHOLD_MIN, rec['threshold']))
      : REVIEW_DEFAULT_THRESHOLD;
  const rounds =
    typeof rec['maxRoundsPerMilestone'] === 'number' && Number.isFinite(rec['maxRoundsPerMilestone'])
      ? Math.min(REVIEW_ROUNDS_MAX, Math.max(0, Math.round(rec['maxRoundsPerMilestone'])))
      : REVIEW_DEFAULT_ROUNDS;
  const axesRec =
    typeof rec['axes'] === 'object' && rec['axes'] !== null
      ? (rec['axes'] as Record<string, unknown>)
      : {};
  const axis = (k: string): boolean => (typeof axesRec[k] === 'boolean' ? (axesRec[k] as boolean) : true);
  // M26-1: passMode('severity'|'score')。3値以外は未指定(=severity扱い)に正規化
  const passMode =
    rec['passMode'] === 'severity' || rec['passMode'] === 'score' ? rec['passMode'] : undefined;
  return {
    enabled: rec['enabled'],
    ...(passMode !== undefined ? { passMode } : {}),
    threshold,
    maxRoundsPerMilestone: rounds,
    axes: { code: axis('code'), ux: axis('ux'), requirements: axis('requirements'), tests: axis('tests') },
  };
}

/** M18: modelPolicy の読み込みバリデーション。形が崩れていたら未設定(=無効)として扱う */
export function parseModelPolicy(raw: unknown): ModelPolicy | null {
  const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!rec || typeof rec['enabled'] !== 'boolean') return null;
  const planner = parseBand(rec['planner']);
  const worker = parseBand(rec['worker']);
  if (!planner || !worker) return null;
  const policy: ModelPolicy = { enabled: rec['enabled'], planner, worker };
  const escalation = parseBand(rec['escalation']);
  if (escalation) policy.escalation = escalation;
  // M26-2: reviewer 帯(壊れた形は未指定=planner代行として扱う)
  const reviewer = parseBand(rec['reviewer']);
  if (reviewer) policy.reviewer = reviewer;
  const max = rec['maxEscalationsPerTask'];
  if (typeof max === 'number' && Number.isFinite(max)) {
    policy.maxEscalationsPerTask = Math.min(MAX_ESCALATIONS_MAX, Math.max(0, Math.round(max)));
  }
  return policy;
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
      // M18: モデル自動切替(壊れた形は未設定=無効へフォールバック)
      const policy = parseModelPolicy(rec['modelPolicy']);
      if (policy) merged.modelPolicy = policy;
      // M19: 品質レビュー・ゲート(同上)
      const review = parseReviewGate(rec['reviewGate']);
      if (review) merged.reviewGate = review;
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
    // M18: 保存時にも正規化(不正形は未設定へ、格上げ回数はクランプ)
    if (clone.modelPolicy !== undefined) {
      const policy = parseModelPolicy(clone.modelPolicy);
      if (policy) clone.modelPolicy = policy;
      else delete clone.modelPolicy;
    }
    // M19: 同上
    if (clone.reviewGate !== undefined) {
      const review = parseReviewGate(clone.reviewGate);
      if (review) clone.reviewGate = review;
      else delete clone.reviewGate;
    }
    this.config = clone;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    return this.get();
  }
}
