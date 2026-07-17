import { describe, expect, it } from 'vitest';
import { alreadyOut, draftStatusAfter, mentionsUnreleased } from '../../shared/operations';
import { stripUnreleasedLines } from './manager';

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

/**
 * M57: **「出した」と「出す準備ができた」は違う**。
 *
 * 実害: Zenn記事は published:false でコミットされ、GitHub Release は draft で作られる。
 * どちらも外からは誰も読めない。にもかかわらずアプリは「投稿済み」と記録し、神議は
 * 「7/12だけでzenn5件・x4件を投下したのに反応が無い = 物量>質が問題」と結論した。
 * 実際に公開されていたZenn記事は**1本だけ**。反応が無いのは当たり前で、原因は物量でも
 * 質でもなく「公開ボタンが押されていない」だった。神に嘘のデータを与えると嘘の結論が返る。
 */
describe('M57: 公開された発信と、公開待ちを分ける', () => {
  it('Zenn(published:false)とGitHub Release(draft)は staged = まだ誰も読めない', () => {
    expect(draftStatusAfter('zenn-repo')).toBe('staged');
    expect(draftStatusAfter('github')).toBe('staged');
  });

  it('X・Blueskyは posted = 出れば公開されている(最後のクリックが人間でも)', () => {
    expect(draftStatusAfter('x')).toBe('posted');
    expect(draftStatusAfter('bluesky')).toBe('posted');
  });

  it('staged も「もう外へ出す処理を通した」側 = 二度コミットしない', () => {
    expect(alreadyOut('staged')).toBe(true);
    expect(alreadyOut('posted')).toBe(true);
    expect(alreadyOut('draft')).toBe(false);
    expect(alreadyOut('discarded')).toBe(false);
  });
});

/**
 * M59: 出力を捨てるだけでは足りなかった。神はPROGRESS.mdと直近コミットを読んで
 * 「一番面白いこと」を書く — 今それは月読だ。実機では2571トークンで生成された3件が
 * **全部月読の話**で、ガードが全部捨てた。神は毎回同じことを書いてトークンを捨て続ける。
 * **見せなければ書けない。**
 */
describe('M59: 発信の素材からも未公開話題を抜く', () => {
  it('月読に触れる行だけを落とし、公開してよい行は残す', () => {
    const progress = [
      '## M57: 「出した」と「出す準備ができた」を分ける',
      '## M42(月読): 記憶の義手 — 常時聴取のVAD調整',
      '## M50: 進化ジョブの残骸B環境とID再利用の衝突',
      '- whisper.cpp をローカルで動かす',
    ].join('\n');

    const stripped = stripUnreleasedLines(progress);

    expect(stripped).toContain('M57');
    expect(stripped).toContain('M50');
    expect(stripped).not.toContain('月読');
    expect(stripped).not.toContain('whisper');
  });

  it('未公開話題の見出し節は小見出しやStage行も含めて落とす', () => {
    const progress = ['## M42(月読)', '### 総括', '耳の実測値', 'Stage 5b の話', '## M63: 言行一致', '神議の話'].join('\n');

    const stripped = stripUnreleasedLines(progress);

    expect(stripped).toBe('## M63: 言行一致\n神議の話');
  });
});
