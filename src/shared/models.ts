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
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash(既定・無料枠向け)' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite(最軽量・上限が緩い)' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro(高性能・無料枠は少なめ)' },
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
};

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
  // M25-4: gpt-5.1 は旧世代(2026-07時点でOpenAI公式カタログから既に外れている)。
  // 現行フラッグシップの gpt-5.5 を既定に(フォールバック時の実力不足対策)
  openai: 'gpt-5.5',
};

export const KNOWN_MODELS: Record<ProviderId, ModelChoice[]> = {
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5(既定)' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  // M25-4: 2026-07時点の現行ラインナップへ更新。旧 gpt-5/gpt-4.1/gpt-4o はOpenAI側で
  // 既にカタログ落ちしているため候補から除外(gpt-5.1のみ移行期間の互換で残す)
  openai: [
    { id: 'gpt-5.5', label: 'GPT-5.5(既定・最上位)' },
    { id: 'gpt-5.4', label: 'GPT-5.4(廉価版フラッグシップ)' },
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
