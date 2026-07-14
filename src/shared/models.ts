// 既知モデルの候補一覧。設定UIのドロップダウンに使う。
// プレースホルダの説明文をそのまま入力してしまう事故を防ぐため、自由入力ではなく
// 候補から選ぶ + 明示的な「カスタム」入力に分ける。
import type { ProviderId, ProviderPresetId } from './types';

export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * M27-1: 無料APIモードのプロバイダプリセット。OpenAI互換エンドポイントとして
 * openai SDK(baseURL差し替え)で動かす。キーは SecretStore の専用スロットに保存。
 * モデルIDは提供元都合で変わりうるため、UI側は「カスタム」入力も必ず残すこと
 */
export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: ModelChoice[];
  /** APIキー取得ページ(main側の固定allowlist経由で開く) */
  keyPageUrl: string;
  /** かんたんセットアップの3ステップ案内 */
  steps: string[];
  /** レート制限(429)時の平易なユーザー向け文言 */
  rateLimitNotice: string;
}

export const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini(無料枠が最も太い・推奨)',
    // 末尾スラッシュなし(OpenAI SDKのパス連結で "//" → 404 になるため。M29-1)
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // M29-1: 現行世代へ更新(2026-07-11 に https://ai.google.dev/gemini-api/docs/models で確認。
    // gemini-3.5-flash=最新Flash(安定)、gemini-3.1-flash-lite=軽量(安定)。
    // 2.5系も提供継続中のため旧世代として1つ残す)
    defaultModel: 'gemini-3.5-flash',
    models: [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash(既定・最新・無料枠向け)' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite(最軽量・上限が緩い)' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash(旧世代・安定)' },
    ],
    keyPageUrl: 'https://aistudio.google.com/apikey',
    steps: [
      'Googleアカウントで Google AI Studio にログイン',
      '「Get API key」→「Create API key」でキーを作成(カード登録不要)',
      '表示されたキーをコピーして下の欄に貼り付け→保存→接続テスト',
    ],
    rateLimitNotice:
      '無料枠の上限に達しました(Gemini)。1分あたりの上限なら少し待つと再開できます。1日の上限に達した場合は翌日(太平洋時間の深夜)にリセットされます',
  },
  groq: {
    id: 'groq',
    label: 'Groq(高速・無料枠あり)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B(既定・バランス型)' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B(最速・軽量)' },
    ],
    keyPageUrl: 'https://console.groq.com/keys',
    steps: [
      'GroqCloud のコンソールにサインアップ(GitHub/Googleアカウント可・カード登録不要)',
      '「API Keys」→「Create API Key」でキーを作成',
      '表示されたキーをコピーして下の欄に貼り付け→保存→接続テスト',
    ],
    rateLimitNotice:
      '無料枠の上限に達しました(Groq)。1分あたりの上限なら少し待つと再開できます。1日の上限に達した場合は明日リセットされます',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter(多モデル・:free系)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B :free(既定)' },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 :free(推論型)' },
    ],
    keyPageUrl: 'https://openrouter.ai/settings/keys',
    steps: [
      'OpenRouter にサインアップ(Google/GitHubアカウント可・カード登録不要)',
      '「Keys」→「Create Key」でキーを作成',
      '表示されたキーをコピーして下の欄に貼り付け→保存→接続テスト',
    ],
    rateLimitNotice:
      '無料枠の上限に達しました(OpenRouter)。:free モデルは1日あたりの回数制限があり、明日リセットされます',
  },
  /**
   * M35-5: 任意のOpenAI互換エンドポイント(Ollama・LM Studio・vLLM等)。
   * baseUrl はここでは固定できない — 実接続は config.customBaseUrl を使う
   * (service.createProvider が special-case)。models も自由入力
   */
  custom: {
    id: 'custom',
    label: 'カスタム(OpenAI互換 — Ollama等のローカルモデルも可)',
    baseUrl: '',
    defaultModel: '',
    models: [],
    keyPageUrl: '',
    steps: [
      '接続先のbaseURLを入力(例: Ollama は http://localhost:11434/v1)',
      'モデルIDを入力(例: llama3.3、qwen2.5-coder:32b など接続先にあるもの)',
      'APIキーが必要な接続先なら下の欄で保存(localhost系は不要)→接続テスト',
    ],
    rateLimitNotice:
      '接続先の利用上限(またはローカルモデルの処理待ち)に達した可能性があります。少し待って再試行してください',
  },
};

/**
 * M35-5: ローカル接続先か(キー不要判定・純関数)。
 * localhost / 127.x / [::1] / 0.0.0.0 をローカル扱いにする
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * M29-4: 公式コミュニティレジストリのベースURL(registryUrl の既定値)。
 * 未公開の間は不達だが、検索側が静かにスキップするため無害(公開と同時に有効化される)。
 * 空文字に設定すると検索無効。社内レジストリ等への差し替えも可
 */
export const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/moriwo-dev-ai/amateras-registry/main';

/**
 * M42-1: 更新確認の既定URL(GitHub Releases API の latest)。
 * 確認するのは「新しい版があるか」だけで、ダウンロードも書き換えもしない。
 * 空文字に設定すると更新確認を無効化(オフライン運用・フォーク運用)
 */
export const DEFAULT_UPDATE_CHECK_URL = 'https://api.github.com/repos/moriwo-dev-ai/ama-teras/releases/latest';

/**
 * M91-3: 本体(コア/UI)への要望の宛先。ツールは自分の機体で作れるが、コア/UIは作れない
 * (全員が同じコアを使う設計)。行き止まりに当たったことを届ける先がこのリポジトリ。
 * 送信は必ず人間の全文承認を通る。空文字にすると要望の提出を無効化できる
 */
export const DEFAULT_REQUESTS_REPO_URL = 'https://github.com/moriwo-dev-ai/ama-teras';

/**
 * M91-6: GitHub Device Flow で使う公式 OAuth App の Client ID。
 * **Client ID は公開情報**(秘密ではない)なので同梱してよい。Device Flow は Client Secret を
 * 使わない。空文字のあいだは「GitHubと接続」ボタンは使えず、トークン貼り付けにフォールバックする。
 * オーナーが OAuth App(Device Flow 有効)を作って、この値か設定の githubClientId に入れると有効化される
 */
export const DEFAULT_GITHUB_CLIENT_ID = '';

/** 公開・要望に必要な最小スコープ(公開リポジトリへの fork/PR/Issue) */
export const GITHUB_OAUTH_SCOPE = 'public_repo';

/**
 * 無料枠APIの学習利用に関する注意文(プリセット共通)。
 * 提供元・プランにより扱いが異なるため断定せず、機密は有料APIへ誘導する
 */
export const FREE_API_TRAINING_NOTICE =
  '無料枠のAPIでは、入力したデータが提供元のモデル改善(学習)に使われる場合があります。' +
  '機密情報・業務データを扱う作業には有料API(Anthropic/OpenAI)の利用を推奨します';

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  // M11-5: 自律開発向けの既定を Fable 5 へ(長時間の自走・エージェント動作に最適化されたモデル)
  anthropic: 'claude-fable-5',
  // M30-1: 2026-07-09 GA の GPT-5.6 世代へ更新。フラッグシップは Sol
  // (2026-07-11 確認: https://developers.openai.com/api/docs/models/gpt-5.6-sol )
  openai: 'gpt-5.6-sol',
};

export const KNOWN_MODELS: Record<ProviderId, ModelChoice[]> = {
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5(既定)' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  // M30-1: GPT-5.6 世代(Sol=フラッグシップ/Terra=中位/Luna=最安)を追加。
  // IDと段構成は 2026-07-11 に公式ドキュメントで確認:
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  // https://openai.com/index/gpt-5-6/ (2026-07-09 GA。エイリアス gpt-5.6 は Sol に解決)
  // 旧 gpt-5.5系は後方互換のため候補に残す(M25-4の方針を継続)
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol(既定・フラッグシップ)' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra(中位・バランス型)' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna(最安・高速)' },
    { id: 'gpt-5.5', label: 'GPT-5.5(旧フラッグシップ)' },
    { id: 'gpt-5.4', label: 'GPT-5.4(旧世代・廉価版フラッグシップ)' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex(エージェント型コーディング特化)' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini(軽量・サブエージェント向け)' },
    { id: 'gpt-5.1', label: 'GPT-5.1(旧世代・非推奨)' },
  ],
};

/** モデルIDが既知候補に含まれるか(含まれなければ「カスタム」扱い) */
export function isKnownModel(provider: ProviderId, model: string): boolean {
  return KNOWN_MODELS[provider].some((m) => m.id === model);
}

/**
 * M13-1: モデルのコンテキスト上限(トークン)。compaction の実測トリガーに使う。
 * 実上限が不明・変動しうるため保守的な値。未知モデルは DEFAULT_CONTEXT_LIMIT。
 * 前方一致で引く(バージョンサフィックス付きIDにも効かせる)。
 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

// M25-4: gpt-5.4系はmini/nanoの方がprefixが長い(gpt-5.4-mini は 'gpt-5.4' で始まる)ため、
// 先頭一致は必ず具体的なIDを先に置く。最後の 'gpt-5' は gpt-5 / gpt-5.1 等の旧世代の受け皿
const CONTEXT_LIMITS: [prefix: string, limit: number][] = [
  ['claude-', 200_000],
  // M27-1: 無料APIモードのプリセット系(値は保守的に)
  ['gemini-2.5-flash-lite', 1_000_000],
  ['gemini-', 1_000_000],
  // M30-1: GPT-5.6 世代は3層とも 1,050,000(2026-07-11 公式モデルページで確認)
  ['gpt-5.6', 1_050_000],
  ['llama-3.3-70b', 128_000],
  ['llama-3.1-8b', 128_000],
  ['meta-llama/', 128_000],
  ['deepseek/', 64_000],
  ['gpt-5.5', 1_050_000],
  ['gpt-5.4-mini', 400_000],
  ['gpt-5.4-nano', 400_000],
  ['gpt-5.4', 1_050_000],
  ['gpt-5.3-codex', 400_000],
  ['gpt-5', 200_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
];

export function contextLimitFor(model: string): number {
  for (const [prefix, limit] of CONTEXT_LIMITS) {
    if (model.startsWith(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * M41-4: 既知モデルの単価($/1Mトークン)。前方一致で照合。未知モデルはコスト非表示。
 * main(usage)と renderer(想定コスト表示)の両方が使うので shared に置く
 */
export interface ModelPrice { prefix: string; input: number; output: number; cacheReadRatio: number }
export const MODEL_PRICES: ModelPrice[] = [
  { prefix: 'anthropic/claude-fable-5', input: 10, output: 50, cacheReadRatio: 0.1 },
  { prefix: 'anthropic/claude-opus', input: 5, output: 25, cacheReadRatio: 0.1 },
  // Sonnet 5 は 2026-08-31 まで導入価格($2/$10)だが、概算は定価で出す(高め=安全側)
  { prefix: 'anthropic/claude-sonnet', input: 3, output: 15, cacheReadRatio: 0.1 },
  { prefix: 'anthropic/claude-haiku', input: 1, output: 5, cacheReadRatio: 0.1 },
  // M30-1: GPT-5.6 世代(2026-07-11 公式確認: Sol $5/$30・Terra $2.5/$15・Luna $1/$6)。
  // terra/luna を sol より先に置く(前方一致の誤照合防止)。素の 'gpt-5.6'(エイリアス)は
  // Sol に解決されるため最後の gpt-5.6 で Sol と同額で受ける
  { prefix: 'openai/gpt-5.6-terra', input: 2.5, output: 15, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.6-luna', input: 1, output: 6, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.6', input: 5, output: 30, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.5', input: 5, output: 30, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.4-mini', input: 0.75, output: 4.5, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.4-nano', input: 0.2, output: 1.25, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.4', input: 2.5, output: 15, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.3-codex', input: 1.75, output: 14, cacheReadRatio: 0.1 },
];
