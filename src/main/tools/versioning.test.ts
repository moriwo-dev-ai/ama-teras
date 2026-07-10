import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION, satisfiesApiRange } from './versioning';

describe('M27-5: satisfiesApiRange(プラグインAPIの互換範囲)', () => {
  it('現行APIは v1 系(凍結の前提)', () => {
    expect(PLUGIN_API_VERSION.startsWith('1.')).toBe(true);
  });

  it('キャレット範囲: メジャー一致かつ指定以上', () => {
    expect(satisfiesApiRange('^1', '1.0.0')).toBe(true);
    expect(satisfiesApiRange('^1', '1.9.3')).toBe(true);
    expect(satisfiesApiRange('^1.2', '1.1.0')).toBe(false); // 指定未満
    expect(satisfiesApiRange('^1.2', '1.3.0')).toBe(true);
    expect(satisfiesApiRange('^2', '1.5.0')).toBe(false); // メジャー不一致
    expect(satisfiesApiRange('^1', '2.0.0')).toBe(false);
  });

  it('チルダ範囲: メジャー・マイナー一致かつ指定以上', () => {
    expect(satisfiesApiRange('~1.0', '1.0.5')).toBe(true);
    expect(satisfiesApiRange('~1.0.3', '1.0.2')).toBe(false);
    expect(satisfiesApiRange('~1.0', '1.1.0')).toBe(false);
  });

  it('演算子なし: 指定桁までの一致', () => {
    expect(satisfiesApiRange('1', '1.8.2')).toBe(true);
    expect(satisfiesApiRange('1.8', '1.8.9')).toBe(true);
    expect(satisfiesApiRange('1.8', '1.9.0')).toBe(false);
    expect(satisfiesApiRange('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesApiRange('1.0.0', '1.0.1')).toBe(false);
  });

  it('解釈できない範囲は false(安全側=無効化)', () => {
    expect(satisfiesApiRange('>=1 <2')).toBe(false);
    expect(satisfiesApiRange('*')).toBe(false);
    expect(satisfiesApiRange('')).toBe(false);
    expect(satisfiesApiRange('latest')).toBe(false);
  });

  it('既定引数で現行APIバージョンと照合する', () => {
    expect(satisfiesApiRange('^1')).toBe(true);
    expect(satisfiesApiRange('^2')).toBe(false);
  });
});
