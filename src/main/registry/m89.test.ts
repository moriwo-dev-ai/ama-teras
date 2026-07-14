import { describe, expect, it } from 'vitest';
import { matchRegistryEntries, mentionedNegatively } from './search';
import type { RegistryIndexEntry } from './search';

/**
 * M89: **「text_stats は不適合」と書くほど text_stats が選ばれていた**。
 *
 * 実機(配布版)で、xlsx作成ツールを頼んだのに text_stats(文字数を数えるツール)が候補になり、
 * 却下したあと「text_stats はテキスト統計ツールであり不適合。該当が無ければ該当なしと返して」と
 * 明示して頼み直したら、**その否定文が名前の一致として +5 点になり、また1位で導入された**。
 * 名前の言及は「欲しい」とは限らない。「要らない」と言うためにも名前は出る。
 */

const entry = (name: string, description: string): RegistryIndexEntry =>
  ({ name, version: '1.0.0', description, author: 'x', verified: true, files: [] }) as unknown as RegistryIndexEntry;

const ENTRIES = [
  entry('text_stats', 'テキストの文字数・行数・単語数・バイト数を数えるツール'),
  entry('xlsx_writer', '表データから Excel の .xlsx ワークブックを生成するツール(複数シート対応)'),
];

describe('M89: 否定された名前を、望みだと取り違えない', () => {
  it('「text_stats は不適合」と書かれた依頼で、text_stats を候補にしない', () => {
    const query =
      'Excel .xlsx ファイルを作るツールが欲しい。text_stats はテキスト統計ツールであり不適合。' +
      'xlsx / excel / spreadsheet の能力を持つものを探してほしい';

    const names = matchRegistryEntries(ENTRIES, query).map((m) => m.entry.name);

    expect(names).not.toContain('text_stats'); // 実機で導入されてしまったやつ
    expect(names[0]).toBe('xlsx_writer');
  });

  it('素直に名前で指名した依頼では、これまでどおり強く効く', () => {
    const names = matchRegistryEntries(ENTRIES, 'text_stats を入れてほしい。文字数を数えたい').map(
      (m) => m.entry.name,
    );
    expect(names[0]).toBe('text_stats');
  });

  it('かすっただけのバイグラム一致では候補にしない(しきい値)', () => {
    // 「ツール」しか重ならない依頼。以前は score>0 で候補になっていた
    const names = matchRegistryEntries([entry('text_stats', 'テキストの文字数を数えるツール')], '画像を回転するツール').map(
      (m) => m.entry.name,
    );
    expect(names).toEqual([]);
  });

  it('否定の判定は前後の文脈だけを見る(遠くの否定語に引きずられない)', () => {
    expect(mentionedNegatively('text_stats は不適合', 'text_stats')).toBe(true);
    expect(mentionedNegatively('text_stats ではなく xlsx が欲しい', 'text_stats')).toBe(true);
    // 近傍(前後24文字)だけを見る。遠く離れた別の話の否定語には引きずられない
    expect(
      mentionedNegatively('text_stats を入れてほしい。文字数を数えたい。ちなみに画像処理の機能は不要', 'text_stats'),
    ).toBe(false);
  });
});
