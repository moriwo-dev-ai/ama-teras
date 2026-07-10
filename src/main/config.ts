import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AppConfig,
  ModelBand,
  ModelPolicy,
  ProviderPresetId,
  ReviewGateConfig,
} from '../shared/types';

/** M11-1: maxTurns のクランプ範囲。未設定はループ側の既定(30)に委ねる */
export const MAX_TURNS_MIN = 1;
export const MAX_TURNS_MAX = 200;

export function clampMaxTurns(value: number): number {
  return Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, Math.round(value)));
}

/** M18: 格上げ回数のクランプ(0=格上げ無効〜3) */
export const MAX_ESCALATIONS_MAX = 3;

// ---- M27-1: 無料APIモード ----

/** freeMode時の maxTurns 既定(明示設定があればそちらを優先) */
export const FREE_MODE_DEFAULT_MAX_TURNS = 15;

export function parseProviderPreset(raw: unknown): ProviderPresetId | undefined {
  return raw === 'gemini' || raw === 'groq' || raw === 'openrouter' ? raw : undefined;
}

/**
 * freeMode の実効 maxTurns。明示設定 > freeMode既定(15) > 未設定(ループ既定30)。
 * service はこの関数経由で読むこと(gating の正本をここに置く)
 */
export function effectiveMaxTurns(cfg: AppConfig): number | undefined {
  if (cfg.maxTurns !== undefined) return cfg.maxTurns;
  return cfg.freeMode === true ? FREE_MODE_DEFAULT_MAX_TURNS : undefined;
}

/** freeMode ではレビューゲートを常に無効化(無料モデルは通過率が低く枠を溶かすだけになる) */
export function effectiveReviewGate(cfg: AppConfig): ReviewGateConfig | undefined {
  return cfg.freeMode === true ? undefined : cfg.reviewGate;
}

/** freeMode では ModelPolicy(帯別モデル)を常に無効化(帯ごとの有料キー前提の機構のため) */
export function effectiveModelPolicy(cfg: AppConfig): ModelPolicy | undefined {
  return cfg.freeMode === true ? undefined : cfg.modelPolicy;
}

/**
 * freeMode で自己進化(request_capability の新規生成)を止める理由文。
 * null = 制限なし。freeModeAllowEvolution=true でオプトイン解除できる
 */
export function evolutionDisabledReason(cfg: AppConfig): string | null {
  if (cfg.freeMode === true && cfg.freeModeAllowEvolution !== true) {
    return (
      '無料モードでは新規生成は行えません(無料枠を消費しやすいため)。' +
      '将来はコミュニティの共有プラグインを検索できるようになります。' +
      '今すぐ生成したい場合は、設定の「基本」タブ →「無料モードでも自己進化を許可」をONにしてください'
    );
  }
  return null;
}

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
  // M26-3: 中間格上げ先・調査帯(壊れた形は未指定=各フォールバックへ)
  const midEscalation = parseBand(rec['midEscalation']);
  if (midEscalation) policy.midEscalation = midEscalation;
  const explorer = parseBand(rec['explorer']);
  if (explorer) policy.explorer = explorer;
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
      // M27-1: 無料APIモード(不正値は未設定として扱う)
      const preset = parseProviderPreset(rec['providerPreset']);
      if (preset !== undefined) merged.providerPreset = preset;
      if (typeof rec['freeMode'] === 'boolean') merged.freeMode = rec['freeMode'];
      if (typeof rec['freeModeAllowEvolution'] === 'boolean') {
        merged.freeModeAllowEvolution = rec['freeModeAllowEvolution'];
      }
      if (typeof rec['workspace'] === 'string' && rec['workspace'] !== '') merged.workspace = rec['workspace'];
      // M27-4: 失効リストURL(キルスイッチ)。http(s) のみ受け入れる
      if (
        typeof rec['pluginRevocationUrl'] === 'string' &&
        /^https?:\/\//.test(rec['pluginRevocationUrl'])
      ) {
        merged.pluginRevocationUrl = rec['pluginRevocationUrl'];
      }
      // M28-3: レジストリURL(作る前に探す)。同上
      if (typeof rec['registryUrl'] === 'string' && /^https?:\/\//.test(rec['registryUrl'])) {
        merged.registryUrl = rec['registryUrl'];
      }
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
    // M27-1: 不正なプリセットIDは未設定へ正規化(IPC経由の範囲外値を防ぐ)
    if (clone.providerPreset !== undefined && parseProviderPreset(clone.providerPreset) === undefined) {
      delete clone.providerPreset;
    }
    // M27-4: 失効リストURLは http(s) のみ。空文字・不正形式は未設定へ
    if (clone.pluginRevocationUrl !== undefined && !/^https?:\/\//.test(clone.pluginRevocationUrl)) {
      delete clone.pluginRevocationUrl;
    }
    // M28-3: レジストリURLも同様に正規化
    if (clone.registryUrl !== undefined && !/^https?:\/\//.test(clone.registryUrl)) {
      delete clone.registryUrl;
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
