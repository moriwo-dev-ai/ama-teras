import { describe, expect, it } from 'vitest';
import { mentionsUnreleased } from '../../shared/operations';

/**
 * M49: 未公開機能の発信ガード。
 *
 * **実害**: 神(AMENO-uzume)が月読モード(未公開)の開発記を書き、承認バッチに載り、
 * Zenn記事として**公開リポジトリに push された**。`published: false` でも、リポジトリが
 * PUBLIC なら GitHub 上でソースは誰でも読める。カメラ・マイク・VAD・権限設計まで書かれていた。
 *
 * 神は「何が未公開か」を知らない。プロンプトで教えるのではなく、**通さない**:
 * 生成時に捨てる → 承認バッチに載せない → 発信直前でも弾く(三重)。
 */
describe('M49: 未公開機能(月読)の発信ガード', () => {
  it('月読に触れる発信を検出する(表記ゆれ・英字も)', () => {
    expect(mentionsUnreleased('M42(月読): 記憶の義手')).toBe(true);
    expect(mentionsUnreleased('誤爆を2回起こしてわかった「在席検知」の作り方')).toBe(true);
    expect(mentionsUnreleased('TUKU-yomi の常時聴取について')).toBe(true);
    expect(mentionsUnreleased('whisper.cpp をローカルで動かす話')).toBe(true);
    expect(mentionsUnreleased('つくよみと呼ぶと反応する')).toBe(true);
    expect(mentionsUnreleased('月の帳に残る')).toBe(true);
  });

  it('公開してよい話は通す(ガードで発信そのものを殺さない)', () => {
    expect(mentionsUnreleased('stop()が止めていなかった — 幽霊スケジューラ事件')).toBe(false);
    expect(mentionsUnreleased('レジストリで神を配り、更新を知らせる')).toBe(false);
    expect(mentionsUnreleased('承認なしでは物理的に発信できないAIエージェント')).toBe(false);
  });
});

/**
 * M54: 神議は**投稿履歴**からも未公開話題を見せられていた。削除済みの月読記事を
 * 「閲覧を作れている読み物」として分析に持ち出し、続編を書こうとした。
 * 出さない話題は、出した記録も持たせない(生成・承認・実行の三重ガードに続く4枚目)。
 */
describe('M54: 神議の入力(投稿履歴)からも未公開話題を外す', () => {
  it('X投稿された「通り過ぎただけでおかえり」本文は在席検知に触れるので弾かれる', () => {
    const body =
      '在席検知、実カメラで2回誤爆させました。①静止すると差分0.0045まで落ちて「戻れない」' +
      '②今度は目の前を通り過ぎただけで「おかえり」。#AMAteras';

    expect(mentionsUnreleased(`「通り過ぎただけで、おかえり」と言われた話\n${body}`)).toBe(true);
  });
});
