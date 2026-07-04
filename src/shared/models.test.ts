import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, isKnownModel, KNOWN_MODELS } from './models';

describe('models', () => {
  it('既定モデルは各プロバイダの候補に含まれる', () => {
    expect(isKnownModel('anthropic', DEFAULT_MODELS.anthropic)).toBe(true);
    expect(isKnownModel('openai', DEFAULT_MODELS.openai)).toBe(true);
  });

  it('M11-5: Anthropic の既定は claude-fable-5', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-fable-5');
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
});
