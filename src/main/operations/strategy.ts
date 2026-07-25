import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * M103: 戦略台帳(userData/operations/strategy.md)。
 *
 * これまで神議は毎回「圧縮スナップショット」だけを渡される記憶喪失の参謀だった —
 * ミッションも過去の決定も自分では覚えていない。Claude Code が長期運営できるのは
 * 自分で読み書きする台帳(growth-loop.md)を持つからで、その仕組みを移植する。
 *
 * 設計:
 * - ヘッダ部(ミッション・目標値)は人間が編集する領域。プログラムは触らない
 * - 「## 実行台帳」以下に神議が日付付きで追記する(append のみ。書き換え・削除はしない)
 * - サイズ上限を超えたら**古い台帳エントリから**落とす(ヘッダは絶対に守る)
 * - ファイルが壊れていても運営は止まらない(読めなければ空として扱う)
 */

export const STRATEGY_FILE = 'strategy.md';
/** 台帳の肥大でプロンプトを食い潰さないための上限(全文をプロンプトに入れる前提のサイズ) */
export const STRATEGY_MAX_CHARS = 16_000;
const LEDGER_HEADING = '## 実行台帳(新しいものが上・神議が追記)';

export const STRATEGY_INITIAL = `# 運営戦略台帳

このファイルは運営AI(神議)の長期記憶。ヘッダ(ここから実行台帳まで)は人間が編集し、
実行台帳は神議が追記する。

## ミッション
**「企業に囚われないAIエージェントの普及」** — ベンダー非依存・自分の機体で動き
自分のツールを育てる・AGPLオープンソース。「安全なゲート」は差別化の脇役であって主役ではない。

## 目標値(2026-07-23起点・ユーザー承認済み)
- GitHub Star: 2週間で10 / 4週間で30
- インストーラDL累計: 2週間で60 / 4週間で120
- リポ閲覧u(14日窓): 2週間で100
- 質的: Show HN+Reddit実施 / 他人からのフィードバック2件

## 規律
- 外部発信は必ずユーザー承認(岩戸ゲート)。例外なし
- 誇張禁止。数字は一次情報のみ
- 人間指標が2サイクル連続で動かない施策は捨てる

${LEDGER_HEADING}
`;

/** 読む。無ければ初期内容で作る。壊れていて読めなければ空文字(運営は止めない) */
export function readStrategy(dir: string): string {
  const p = join(dir, STRATEGY_FILE);
  try {
    if (!existsSync(p)) {
      writeFileSync(p, STRATEGY_INITIAL, 'utf8');
      return STRATEGY_INITIAL;
    }
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 台帳へ1エントリ追記(新しいものが上)。ヘッダは触らない。
 * 上限超過時は最も古いエントリから捨てる。エントリは1行に正規化(改行は・に潰す)
 */
export function appendStrategyEntry(dir: string, entry: string, now = new Date()): boolean {
  const p = join(dir, STRATEGY_FILE);
  try {
    const current = existsSync(p) ? readFileSync(p, 'utf8') : STRATEGY_INITIAL;
    const idx = current.indexOf(LEDGER_HEADING);
    const header = idx >= 0 ? current.slice(0, idx + LEDGER_HEADING.length) : `${current.trimEnd()}\n\n${LEDGER_HEADING}`;
    const ledger = idx >= 0 ? current.slice(idx + LEDGER_HEADING.length) : '';
    const line = `- ${now.toISOString().slice(0, 10)}: ${entry.replace(/\s+/g, ' ').trim().slice(0, 500)}`;
    let entries = [line, ...ledger.split('\n').filter((l) => l.startsWith('- '))];
    let out = `${header}\n${entries.join('\n')}\n`;
    while (out.length > STRATEGY_MAX_CHARS && entries.length > 1) {
      entries = entries.slice(0, -1); // 最古(末尾)から捨てる
      out = `${header}\n${entries.join('\n')}\n`;
    }
    writeFileSync(p, out, 'utf8');
    return true;
  } catch {
    return false;
  }
}
