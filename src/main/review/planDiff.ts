/**
 * M19: 計画ファイル(AMATERAS_PLAN.md)のマイルストーン完了検出。
 * plan ツールの write 前後の内容を比較し、新たに `- [x]` になった項目を返す。
 * electron 非依存の純関数(テスト可能)。
 */

/** `- [x] 項目` 形式の完了項目テキスト一覧(先頭記号・チェックボックスを除いた本文) */
export function completedItems(md: string): string[] {
  return md
    .split('\n')
    .map((line) => /^\s*[-*]\s*\[[xX]\]\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((s): s is string => s !== undefined && s !== '');
}

/** before → after で新たに完了した項目(項目テキストの改変はリネーム=新規完了扱い) */
export function newlyCompleted(before: string, after: string): string[] {
  const prev = new Set(completedItems(before));
  return completedItems(after).filter((item) => !prev.has(item));
}
