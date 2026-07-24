import { describe, expect, it } from 'vitest';
import { ja, type MessageKey } from './ja';
import { en } from './en';
import { resolveLang, t, useI18nStore } from './index';

/** M100-1: 辞書の整合と言語解決。型でも守っているが、実行時の空文字・キー欠落もここで拾う */
describe('M100-1: i18n dictionaries', () => {
  it('en は ja の全キーを持ち、値が空でない', () => {
    const jaKeys = Object.keys(ja) as MessageKey[];
    for (const k of jaKeys) {
      expect(en[k], `en missing/empty: ${k}`).toBeTruthy();
      expect(ja[k], `ja empty: ${k}`).toBeTruthy();
    }
    // 余分なキー(jaに無いのにenにある)も禁止 — 辞書のドリフト防止
    expect(Object.keys(en).sort()).toEqual(jaKeys.slice().sort());
  });

  it('プレースホルダはja/enで一致する(翻訳での置換漏れ防止)', () => {
    const holders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(ja) as MessageKey[]) {
      expect(holders(en[k]), `placeholder mismatch: ${k}`).toEqual(holders(ja[k]));
    }
  });
});

describe('M100-1: resolveLang', () => {
  it('明示指定が最優先・autoはOSロケールで分岐', () => {
    expect(resolveLang('ja', 'en-US')).toBe('ja');
    expect(resolveLang('en', 'ja-JP')).toBe('en');
    expect(resolveLang('auto', 'ja-JP')).toBe('ja');
    expect(resolveLang('auto', 'ja')).toBe('ja');
    expect(resolveLang('auto', 'en-US')).toBe('en');
    expect(resolveLang(undefined, 'de-DE')).toBe('en');
    expect(resolveLang(undefined, 'ja-JP')).toBe('ja');
  });
});

describe('M100-1: t()', () => {
  it('言語切替と{n}置換が効く。未知プレースホルダは残す', () => {
    useI18nStore.setState({ lang: 'ja' });
    expect(t('left.minutesAgo', { n: 5 })).toBe('5分前');
    useI18nStore.setState({ lang: 'en' });
    expect(t('left.minutesAgo', { n: 5 })).toBe('5m ago');
    expect(t('app.restarted', {})).toContain('{tag}');
    useI18nStore.setState({ lang: 'ja' });
  });
});
