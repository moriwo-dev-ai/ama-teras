import { describe, expect, it } from 'vitest';
import { contextLimitFor, DEFAULT_MODELS, isKnownModel, KNOWN_MODELS } from './models';

describe('models', () => {
  it('既定モデルは各プロバイダの候補に含まれる', () => {
    expect(isKnownModel('anthropic', DEFAULT_MODELS.anthropic)).toBe(true);
    expect(isKnownModel('openai', DEFAULT_MODELS.openai)).toBe(true);
  });

  it('M11-5: Anthropic の既定は claude-fable-5', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-fable-5');
  });

  it('M25-4: OpenAI の既定は gpt-5.5(旧世代の gpt-5.1 からの更新)', () => {
    expect(DEFAULT_MODELS.openai).toBe('gpt-5.5');
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
