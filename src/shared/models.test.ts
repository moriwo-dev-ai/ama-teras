import { describe, expect, it } from 'vitest';
import { contextLimitFor, DEFAULT_MODELS, FREE_API_TRAINING_NOTICE, isKnownModel, isLocalBaseUrl, KNOWN_MODELS, MODEL_PRICES, MOONSHOT_BASE_URL, PROVIDER_PRESETS } from './models';

describe('models', () => {
  it('既定モデルは各プロバイダの候補に含まれる', () => {
    expect(isKnownModel('anthropic', DEFAULT_MODELS.anthropic)).toBe(true);
    expect(isKnownModel('openai', DEFAULT_MODELS.openai)).toBe(true);
  });

  it('M11-5: Anthropic の既定は claude-fable-5', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-fable-5');
  });

  it('M30-1: OpenAI の既定は GPT-5.6 Sol(2026-07-09 GA世代のフラッグシップ)', () => {
    expect(DEFAULT_MODELS.openai).toBe('gpt-5.6-sol');
  });

  it('M30-1: GPT-5.6 の3層が候補にあり、旧 gpt-5.5系も後方互換で残る', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.1']) {
      expect(isKnownModel('openai', id), id).toBe(true);
    }
  });

  it('M30-1: GPT-5.6 世代のコンテキスト上限は 1,050,000(3層共通)', () => {
    expect(contextLimitFor('gpt-5.6-sol')).toBe(1_050_000);
    expect(contextLimitFor('gpt-5.6-terra')).toBe(1_050_000);
    expect(contextLimitFor('gpt-5.6-luna')).toBe(1_050_000);
  });

  it('候補外のIDはカスタム扱い(false)', () => {
    expect(isKnownModel('anthropic', 'gpt-5.1')).toBe(false);
    expect(isKnownModel('anthropic', 'モデル(空欄で既定)')).toBe(false); // 誤入力例
    expect(isKnownModel('openai', '')).toBe(false);
  });

  it('候補リストは空でない', () => {
    expect(KNOWN_MODELS.anthropic.length).toBeGreaterThan(0);
    expect(KNOWN_MODELS.openai.length).toBeGreaterThan(0);
  });

  it('M25-4: gpt-5.4系はmini/nanoの方が先に照合され、汎用gpt-5.4に埋もれない', () => {
    expect(contextLimitFor('gpt-5.5')).toBe(1_050_000);
    expect(contextLimitFor('gpt-5.4')).toBe(1_050_000);
    expect(contextLimitFor('gpt-5.4-mini')).toBe(400_000);
    expect(contextLimitFor('gpt-5.4-nano')).toBe(400_000);
    expect(contextLimitFor('gpt-5.3-codex')).toBe(400_000);
    // 旧世代(gpt-5.1等)は汎用 'gpt-5' 受け皿
    expect(contextLimitFor('gpt-5.1')).toBe(200_000);
  });
});

describe('M27-1: PROVIDER_PRESETS(無料APIモード)', () => {
  // M35-5: 'custom' は固定baseUrlを持たない特殊プリセット(実接続先は config.customBaseUrl)
  const fixedPresets = Object.values(PROVIDER_PRESETS).filter((p) => p.id !== 'custom');

  it('固定プリセットが https の baseUrl / keyPageUrl と3ステップ案内を持つ', () => {
    for (const p of fixedPresets) {
      expect(p.baseUrl).toMatch(/^https:\/\//);
      expect(p.keyPageUrl).toMatch(/^https:\/\//);
      expect(p.steps).toHaveLength(3);
      expect(p.rateLimitNotice).toContain('無料枠');
    }
  });

  it('既定モデルは候補一覧に含まれる(固定プリセット)', () => {
    for (const p of fixedPresets) {
      expect(p.models.some((m) => m.id === p.defaultModel)).toBe(true);
    }
  });

  it('M35-5: custom プリセットは baseUrl/defaultModel が空(設定値で駆動)で案内を持つ', () => {
    const custom = PROVIDER_PRESETS.custom;
    expect(custom.baseUrl).toBe('');
    expect(custom.defaultModel).toBe('');
    expect(custom.keyPageUrl).toBe(''); // キー取得ページなし(UIはボタンを出さない)
    expect(custom.steps).toHaveLength(3);
  });

  it('M35-5: isLocalBaseUrl はローカル接続先(キー不要)を判定する', () => {
    expect(isLocalBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLocalBaseUrl('http://[::1]:11434/v1')).toBe(true);
    expect(isLocalBaseUrl('https://api.example.com/v1')).toBe(false);
    expect(isLocalBaseUrl('https://localhost.evil.com/v1')).toBe(false); // サブドメイン偽装
    expect(isLocalBaseUrl('not-a-url')).toBe(false);
  });

  it('学習利用の注意文が定義されている', () => {
    expect(FREE_API_TRAINING_NOTICE).toContain('学習');
  });

  it('contextLimitFor がプリセット系モデルを解決する', () => {
    expect(contextLimitFor('gemini-2.5-flash')).toBe(1_000_000);
    expect(contextLimitFor('llama-3.3-70b-versatile')).toBe(128_000);
    expect(contextLimitFor('meta-llama/llama-3.3-70b-instruct:free')).toBe(128_000);
    expect(contextLimitFor('deepseek/deepseek-r1:free')).toBe(64_000);
  });

  it('M96: Moonshot は正式プロバイダ(既定kimi-k3・OpenAI互換baseURL・1M context・単価あり)', () => {
    expect(DEFAULT_MODELS.moonshot).toBe('kimi-k3');
    expect(MOONSHOT_BASE_URL).toBe('https://api.moonshot.ai/v1');
    expect(MOONSHOT_BASE_URL.endsWith('/')).toBe(false);
    expect(contextLimitFor('kimi-k3')).toBe(1_000_000);
    expect(MODEL_PRICES.some((p) => p.prefix === 'moonshot/kimi-k3')).toBe(true);
    // 旧kimiプリセットは廃止(昇格済み)
    expect('kimi' in PROVIDER_PRESETS).toBe(false);
  });
});

describe('M29-1: プリセットのbaseUrlとGemini現行モデル', () => {
  it('全プリセットの baseUrl は末尾スラッシュなし(SDK連結で "//"→404 になるため)', () => {
    for (const p of Object.values(PROVIDER_PRESETS)) {
      expect(p.baseUrl.endsWith('/'), p.id).toBe(false);
    }
  });

  it('Gemini の既定は現行世代 gemini-3.5-flash(2026-07-11 公式docs確認)', () => {
    expect(PROVIDER_PRESETS.gemini.defaultModel).toBe('gemini-3.5-flash');
    expect(contextLimitFor('gemini-3.5-flash')).toBe(1_000_000);
    expect(contextLimitFor('gemini-3.1-flash-lite')).toBe(1_000_000);
  });
});
