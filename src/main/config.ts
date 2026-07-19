import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_REGISTRY_URL, DEFAULT_UPDATE_CHECK_URL } from '../shared/models';
import type {
  AppConfig,
  AutonomousRegistryScope,
  ModelBand,
  ModelPolicy,
  OperationsConfig,
  ProviderPresetId,
  ReviewGateConfig,
  TsukuyomiConfig,
} from '../shared/types';

/** M11-1: maxTurns のクランプ範囲。未設定はループ側の既定(30)に委ねる */
export const MAX_TURNS_MIN = 1;
export const MAX_TURNS_MAX = 200;

export function clampMaxTurns(value: number): number {
  return Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, Math.round(value)));
}

/** M92-A6: 並列生成数のクランプ(1〜4)。headless electron のスモークが同時に走るため上限は控えめ */
export const EVOLUTION_CONCURRENCY_MIN = 1;
export const EVOLUTION_CONCURRENCY_MAX = 4;
export function clampConcurrency(value: number): number {
  return Math.min(EVOLUTION_CONCURRENCY_MAX, Math.max(EVOLUTION_CONCURRENCY_MIN, Math.round(value)));
}

/**
 * M92-A6-3: 生成トークンの上限クランプ(0=無制限)。上限は付けない(ユーザーの財布=従量課金)が、
 * 負値・非整数は弾く。誤って極端に小さい正値を入れると生成が即打ち切られるだけなので実害はない。
 */
export function clampTokenCap(value: number): number {
  return Math.max(0, Math.round(value));
}

/** M18: 格上げ回数のクランプ(0=格上げ無効〜3) */
export const MAX_ESCALATIONS_MAX = 3;

// ---- M27-1: 無料APIモード ----

/** freeMode時の maxTurns 既定(明示設定があればそちらを優先) */
export const FREE_MODE_DEFAULT_MAX_TURNS = 15;

export function parseProviderPreset(raw: unknown): ProviderPresetId | undefined {
  return raw === 'gemini' || raw === 'groq' || raw === 'openrouter' || raw === 'kimi' || raw === 'custom'
    ? raw
    : undefined;
}

/** M29-5: 自律モードの包括承認範囲(不正値は未設定=none扱い) */
export function parseAutonomousRegistryScope(raw: unknown): AutonomousRegistryScope | undefined {
  return raw === 'none' || raw === 'verified' || raw === 'verified-generate' ? raw : undefined;
}

/** M42(TUKU-yomi)の既定値。既定は全部OFF(鉄則6) */
export const TSUKUYOMI_DEFAULTS = {
  interruptBudgetPerDay: 5,
  framesPerHour: 6,
  framesPerDay: 50,
  quietHours: { start: '23:00', end: '07:00' },
  /** M42-7: クラウド文字起こしに送っていい音声の分数/日(青天井にしない) */
  cloudMinutesPerDay: 60,
} as const;

/** 'HH:MM' の妥当性(24時間表記。25:00 のような値は静音時間として成立しない) */
function isHhmm(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/**
 * M42(TUKU-yomi): 月読設定。壊れた形は undefined(=OFF)へフォールバック。
 * 数値は0以上へクランプ。時刻は 'HH:MM' のみ受け入れる。
 * **鍵ファイルによる強制OFFはここではやらない**(ファイルI/Oを持たない純関数のため)。
 * 強制OFFは ConfigStore の read/set が hasOwnerKey 述語で行う
 */
export function parseTsukuyomiConfig(raw: unknown): TsukuyomiConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['enabled'] !== 'boolean') return undefined;
  const out: TsukuyomiConfig = { enabled: rec['enabled'] };
  for (const key of ['voiceOutput', 'camera', 'cameraUnderstanding', 'ears', 'pcObserver', 'conversation', 'wakeWord', 'voiceCommand', 'proactive'] as const) {
    if (typeof rec[key] === 'boolean') out[key] = rec[key];
  }
  const num = (
    key: 'interruptBudgetPerDay' | 'framesPerHour' | 'framesPerDay' | 'cloudMinutesPerDay',
  ): void => {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = Math.floor(v);
  };
  num('interruptBudgetPerDay');
  num('framesPerHour');
  num('framesPerDay');
  num('cloudMinutesPerDay');
  // 文字起こしの場所。知らない値はローカル(音声を出さない側)に倒す
  if (rec['sttMode'] === 'cloud' || rec['sttMode'] === 'local') out.sttMode = rec['sttMode'];
  if (typeof rec['wakeWords'] === 'string' && rec['wakeWords'].trim() !== '') {
    out.wakeWords = rec['wakeWords'].trim();
  }
  if (typeof rec['micDeviceId'] === 'string' && rec['micDeviceId'].trim() !== '') {
    out.micDeviceId = rec['micDeviceId'].trim();
  }
  const quiet = rec['quietHours'];
  if (typeof quiet === 'object' && quiet !== null) {
    const q = quiet as Record<string, unknown>;
    if (isHhmm(q['start']) && isHhmm(q['end'])) out.quietHours = { start: q['start'], end: q['end'] };
  }
  // 映像理解はカメラが前提(camera=false のまま理解だけONにはできない)
  if (out.cameraUnderstanding === true && out.camera !== true) out.cameraUnderstanding = false;
  return out;
}

/**
 * M32-1: 運営設定(オーナーモード)。repos は 'owner/repo' 形式のみ受け入れる。
 * 壊れた形は undefined(=OFF)へフォールバック
 */
export function parseOperationsConfig(raw: unknown): OperationsConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['enabled'] !== 'boolean') return undefined;
  const repos = Array.isArray(rec['repos'])
    ? rec['repos'].filter((r): r is string => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))
    : [];
  const zennSlugs = Array.isArray(rec['zennSlugs'])
    ? rec['zennSlugs'].filter((s): s is string => typeof s === 'string' && /^[\w-]+$/.test(s))
    : [];
  const out: OperationsConfig = { enabled: rec['enabled'], repos, zennSlugs };
  // M34: 追加フィールドは全て任意(旧形式=無しでもそのまま通る)
  if (Array.isArray(rec['watchUrls'])) {
    const urls = rec['watchUrls'].filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
    if (urls.length > 0) out.watchUrls = urls;
  }
  if (typeof rec['hnUser'] === 'string' && /^[\w-]{1,30}$/.test(rec['hnUser'])) out.hnUser = rec['hnUser'];
  if (Array.isArray(rec['hnThreads'])) {
    const threads = rec['hnThreads']
      .map((t) => {
        if (typeof t !== 'string') return null;
        const m = /(?:item\?id=)?(\d{4,12})/.exec(t.trim());
        return m ? m[1]! : null;
      })
      .filter((t): t is string => t !== null);
    if (threads.length > 0) out.hnThreads = threads;
  }
  const parseBand = (v: unknown): ModelBand | undefined => {
    if (typeof v !== 'object' || v === null) return undefined;
    const b = v as Record<string, unknown>;
    if ((b['provider'] === 'anthropic' || b['provider'] === 'openai') && typeof b['model'] === 'string') {
      return { provider: b['provider'], model: b['model'] };
    }
    return undefined;
  };
  const kamu = parseBand(rec['kamuhakariBand']);
  if (kamu !== undefined) out.kamuhakariBand = kamu;
  const gods = parseBand(rec['godsBand']);
  if (gods !== undefined) out.godsBand = gods;
  // M37: Zenn記事のコミット先。ここに無いと保存時に落ちる(=UIで入れても消える)
  if (typeof rec['zennRepoDir'] === 'string' && rec['zennRepoDir'].trim() !== '') {
    out.zennRepoDir = rec['zennRepoDir'].trim();
  }
  // M94: Bluesky投稿への添付メディア(#42で追加されたフィールド。白リスト漏れでUI保存が消えていた)
  if (typeof rec['blueskyMediaPath'] === 'string' && rec['blueskyMediaPath'].trim() !== '') {
    out.blueskyMediaPath = rec['blueskyMediaPath'].trim();
  }
  if (typeof rec['blueskyMediaAlt'] === 'string' && rec['blueskyMediaAlt'].trim() !== '') {
    out.blueskyMediaAlt = rec['blueskyMediaAlt'].trim();
  }
  // M41-3: 神々に渡すプロジェクト像(未設定ならリポジトリ名から推測される)
  if (typeof rec['projectName'] === 'string' && rec['projectName'].trim() !== '') {
    out.projectName = rec['projectName'].trim();
  }
  if (typeof rec['projectDescription'] === 'string' && rec['projectDescription'].trim() !== '') {
    out.projectDescription = rec['projectDescription'].trim();
  }
  // M43-1: 発信の {URL} の解決先。http(s) のみ(投稿に変な文字列を混ぜない)
  if (typeof rec['projectUrl'] === 'string' && /^https?:\/\//.test(rec['projectUrl'].trim())) {
    out.projectUrl = rec['projectUrl'].trim();
  }
  if (Array.isArray(rec['keywords'])) {
    const kws = rec['keywords'].filter((k): k is string => typeof k === 'string' && k.trim() !== '');
    if (kws.length > 0) out.keywords = kws.map((k) => k.trim());
  }
  if (Array.isArray(rec['zennTopics'])) {
    const topics = rec['zennTopics'].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    if (topics.length > 0) out.zennTopics = topics.map((t) => t.trim());
  }
  return out;
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
  // M29-4: 「作る前に探す」の既定は公式レジストリ(未公開の間は不達=静かにスキップ)
  registryUrl: DEFAULT_REGISTRY_URL,
  // M42-1: 更新確認の既定は公式リリース。空文字=無効(通知のみ。自動更新はしない)
  updateCheckUrl: DEFAULT_UPDATE_CHECK_URL,
  // M10: リモートアクセスは既定で無効(有効化はデスクトップの設定UIからのみ)
  remote: { enabled: false, port: 8787 },
};

/** 設定の永続化。electron非依存(テスト可能にするためファイルパスを注入) */
export class ConfigStore {
  private config: AppConfig;

  /**
   * @param hasOwnerKey M42(TUKU-yomi): オーナー鍵(userData/tsukuyomi/.owner)の有無を返す述語。
   *   注入するのは ipc.ts(existsSync)。テストでは偽述語を渡す。
   *   **未注入なら鍵なし扱い**=月読は常にOFF(既存の呼び出し側の挙動を一切変えない)
   */
  constructor(
    private readonly filePath: string,
    private readonly hasOwnerKey: () => boolean = () => false,
  ) {
    this.config = this.read();
  }

  /**
   * M42(TUKU-yomi): 鍵ファイルが無い機体では月読を強制OFFにする(鉄則4)。
   * read/set の両方から呼ぶ — UIの出し分けだけに頼らず、設定の正本で落とす
   */
  private normalizeTsukuyomi(cfg: AppConfig): void {
    if (cfg.tsukuyomi === undefined) return;
    const parsed = parseTsukuyomiConfig(cfg.tsukuyomi);
    if (parsed === undefined) {
      delete cfg.tsukuyomi;
      return;
    }
    cfg.tsukuyomi = parsed;
    if (!this.hasOwnerKey()) {
      // 鍵なし = モードごと停止(目・耳・口も道連れ。ONのまま残さない)
      cfg.tsukuyomi = { ...parsed, enabled: false, camera: false, cameraUnderstanding: false, ears: false, voiceOutput: false, pcObserver: false };
    }
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
      // M92-A5-a: 生成専用モデル(空文字・非文字列は未設定=本体と同じ)
      if (typeof rec['generationModel'] === 'string' && rec['generationModel'].trim() !== '') {
        merged.generationModel = rec['generationModel'].trim();
      }
      // M92-A6: 並列生成数(1〜4にクランプ。非数値・範囲外は未設定=既定2)
      if (typeof rec['evolutionConcurrency'] === 'number' && Number.isFinite(rec['evolutionConcurrency'])) {
        merged.evolutionConcurrency = clampConcurrency(rec['evolutionConcurrency']);
      }
      // M92-A6-3: 生成トークンの上限(0/未設定=無制限)。夜間の大量生成の総量を守る本命
      if (typeof rec['evolutionSessionTokenCap'] === 'number' && Number.isFinite(rec['evolutionSessionTokenCap'])) {
        merged.evolutionSessionTokenCap = clampTokenCap(rec['evolutionSessionTokenCap']);
      }
      if (typeof rec['evolutionPerJobTokenCap'] === 'number' && Number.isFinite(rec['evolutionPerJobTokenCap'])) {
        merged.evolutionPerJobTokenCap = clampTokenCap(rec['evolutionPerJobTokenCap']);
      }
      // M27-1: 無料APIモード(不正値は未設定として扱う)
      const preset = parseProviderPreset(rec['providerPreset']);
      if (preset !== undefined) merged.providerPreset = preset;
      if (typeof rec['freeMode'] === 'boolean') merged.freeMode = rec['freeMode'];
      if (typeof rec['freeModeAllowEvolution'] === 'boolean') {
        merged.freeModeAllowEvolution = rec['freeModeAllowEvolution'];
      }
      // M29-5: 自律モードの包括承認範囲の既定値
      const regScope = parseAutonomousRegistryScope(rec['autonomousRegistryScope']);
      if (regScope !== undefined) merged.autonomousRegistryScope = regScope;
      if (typeof rec['workspace'] === 'string' && rec['workspace'] !== '') merged.workspace = rec['workspace'];
      // M27-4: 失効リストURL(キルスイッチ)。http(s) のみ受け入れる
      if (
        typeof rec['pluginRevocationUrl'] === 'string' &&
        /^https?:\/\//.test(rec['pluginRevocationUrl'])
      ) {
        merged.pluginRevocationUrl = rec['pluginRevocationUrl'];
      }
      // M28-3/M29-4: レジストリURL(作る前に探す)。既定=公式レジストリ。
      // 空文字=検索無効(明示的なオプトアウト)。不正形式は既定へフォールバック
      if (typeof rec['registryUrl'] === 'string') {
        if (rec['registryUrl'] === '' || /^https?:\/\//.test(rec['registryUrl'])) {
          merged.registryUrl = rec['registryUrl'];
        }
      }
      // M91-2: 公開時のクレジット(GitHubのユーザー名等)。空=未設定
      if (typeof rec['registryAuthor'] === 'string') {
        merged.registryAuthor = rec['registryAuthor'].slice(0, 64);
      }
      // M91-6: Device Flow の OAuth App Client ID(公開情報)。空=同梱の既定に従う
      if (typeof rec['githubClientId'] === 'string') {
        merged.githubClientId = rec['githubClientId'].trim().slice(0, 100);
      }
      // M42-1: 更新確認URL。空文字=無効(明示的オプトアウト)。不正形式は既定へフォールバック
      if (typeof rec['updateCheckUrl'] === 'string') {
        if (rec['updateCheckUrl'] === '' || /^https?:\/\//.test(rec['updateCheckUrl'])) {
          merged.updateCheckUrl = rec['updateCheckUrl'];
        }
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
      // M32-1: 運営(オーナーモード)。壊れた形は未設定=OFFへフォールバック
      const operations = parseOperationsConfig(rec['operations']);
      if (operations !== undefined) merged.operations = operations;
      // M42(TUKU-yomi): 壊れた形は未設定=OFFへ。鍵ファイルによる強制OFFは下の normalizeTsukuyomi
      const tsukuyomi = parseTsukuyomiConfig(rec['tsukuyomi']);
      if (tsukuyomi !== undefined) merged.tsukuyomi = tsukuyomi;
      // M35-5: カスタム(OpenAI互換)のbaseURL。http(s)のみ(localhostも可)
      if (typeof rec['customBaseUrl'] === 'string' && /^https?:\/\//.test(rec['customBaseUrl'])) {
        merged.customBaseUrl = rec['customBaseUrl'];
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
      // M42(TUKU-yomi): 鍵ファイルが無ければ読み込み時点で強制OFF
      this.normalizeTsukuyomi(merged);
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
    // M92-A5-a: 生成専用モデルの空欄=本体と同じ(未設定へ正規化)
    if (clone.generationModel !== undefined && clone.generationModel.trim() === '') {
      delete clone.generationModel;
    } else if (clone.generationModel !== undefined) {
      clone.generationModel = clone.generationModel.trim();
    }
    // M92-A6: 並列生成数のクランプ(範囲外・非数値は未設定=既定へ)
    if (clone.evolutionConcurrency !== undefined) {
      if (Number.isFinite(clone.evolutionConcurrency)) {
        clone.evolutionConcurrency = clampConcurrency(clone.evolutionConcurrency);
      } else {
        delete clone.evolutionConcurrency;
      }
    }
    // M92-A6-3: 生成トークン上限のクランプ(非数値は未設定=無制限へ。0は「無制限」の明示として残す)
    for (const key of ['evolutionSessionTokenCap', 'evolutionPerJobTokenCap'] as const) {
      if (clone[key] !== undefined) {
        if (Number.isFinite(clone[key])) clone[key] = clampTokenCap(clone[key] as number);
        else delete clone[key];
      }
    }
    // M27-1: 不正なプリセットIDは未設定へ正規化(IPC経由の範囲外値を防ぐ)
    if (clone.providerPreset !== undefined && parseProviderPreset(clone.providerPreset) === undefined) {
      delete clone.providerPreset;
    }
    // M27-4: 失効リストURLは http(s) のみ。空文字・不正形式は未設定へ
    if (clone.pluginRevocationUrl !== undefined && !/^https?:\/\//.test(clone.pluginRevocationUrl)) {
      delete clone.pluginRevocationUrl;
    }
    // M29-5: 包括承認範囲の不正値は未設定へ
    if (
      clone.autonomousRegistryScope !== undefined &&
      parseAutonomousRegistryScope(clone.autonomousRegistryScope) === undefined
    ) {
      delete clone.autonomousRegistryScope;
    }
    // M28-3/M29-4: レジストリURLの正規化。空文字=無効は保持、不正形式・未設定は既定へ
    if (clone.registryUrl === undefined || (clone.registryUrl !== '' && !/^https?:\/\//.test(clone.registryUrl))) {
      clone.registryUrl = DEFAULT_REGISTRY_URL;
    }
    // M42-1: 更新確認URLの正規化(空文字=無効は保持、不正形式・未設定は既定へ)
    if (
      clone.updateCheckUrl === undefined ||
      (clone.updateCheckUrl !== '' && !/^https?:\/\//.test(clone.updateCheckUrl))
    ) {
      clone.updateCheckUrl = DEFAULT_UPDATE_CHECK_URL;
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
    // M32-1: 運営設定の正規化(不正repos/slugの除外。壊れた形は未設定=OFFへ)
    if (clone.operations !== undefined) {
      const operations = parseOperationsConfig(clone.operations);
      if (operations) clone.operations = operations;
      else delete clone.operations;
    }
    // M42(TUKU-yomi): 保存時も鍵ファイルで強制OFF(UIやIPC経由でONにされても通さない)
    this.normalizeTsukuyomi(clone);
    // M35-5: カスタムbaseURLの正規化(不正形式・空は未設定へ。末尾スラッシュはprovider側で処理)
    if (clone.customBaseUrl !== undefined && !/^https?:\/\//.test(clone.customBaseUrl)) {
      delete clone.customBaseUrl;
    }
    this.config = clone;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    return this.get();
  }
}
