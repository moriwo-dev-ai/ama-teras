import { isAbsolute, relative } from 'node:path';
import { isProtectedFile, PROTECTED_PATHS } from '../evolution/protected';

/**
 * M28-1: 聖域(保護領域)ガードの通常経路(チャット)側。
 * 進化ジョブの聖域トリップワイヤ(evolution/protected.ts)と同じ PROTECTED_PATHS を
 * 単一ソースとして使い、write_file / edit_file 等の宣言パス書き込みを判定する。
 *
 * 方針(NIGHT_TASKS3 T1):
 * - 自律モード or autoApprove.write ON: 聖域への書き込みはハード拒否
 *   (エージェントが無人で自分のガードを書き換える穴を塞ぐ)
 * - 手動モード: 承認ダイアログに聖域警告を明示し、セッション許可に関係なく必ず個別承認
 * - bash 等の exec 系はパスを静的に特定できないため簡易パターン検出のみ
 *   (手動=警告表示 / 自律=書き込み指標との組み合わせで拒否)。完全には防げない制約は
 *   docs/PROTECTED.md に文書化してある
 *
 * このファイル自身も PROTECTED_PATHS に含まれる(ガード自身を守る)。
 */

export interface SanctuaryHit {
  /** リポジトリルート相対パス(/ 区切り) */
  file: string;
  /** マッチした PROTECTED_PATHS エントリ */
  entry: string;
}

/**
 * 絶対パスが「AMA-terasリポジトリ自身の聖域」に入っているか。
 * appRepoRoot(リポジトリルート)の外は対象外(他プロジェクトの同名ファイルを誤検出しない)
 */
export function sanctuaryHitFor(absPath: string, appRepoRoot: string): SanctuaryHit | null {
  const rel = relative(appRepoRoot, absPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const norm = rel.replaceAll('\\', '/');
  const entry = isProtectedFile(norm);
  return entry !== null ? { file: norm, entry } : null;
}

/** 複数パスをまとめて判定(ヒットのみ返す) */
export function sanctuaryHitsFor(absPaths: string[], appRepoRoot: string): SanctuaryHit[] {
  const out: SanctuaryHit[] = [];
  for (const p of absPaths) {
    const hit = sanctuaryHitFor(p, appRepoRoot);
    if (hit !== null) out.push(hit);
  }
  return out;
}

/**
 * exec系(bash等)のコマンド文字列が聖域パスに言及しているか(最初に見つかったエントリを返す)。
 * パス区切りの \ / 混在・大文字小文字を吸収する保守的な部分一致
 */
export function execSanctuaryMention(command: string): string | null {
  const norm = command.replaceAll('\\', '/').toLowerCase();
  for (const p of PROTECTED_PATHS) {
    if (norm.includes(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * コマンド文字列に「書き込みを示唆する」トークンがあるか。
 * 自律モードで聖域言及と組み合わさったときだけハード拒否に使う
 * (grep や vitest 等の読み取り系コマンドまで拒否しないための絞り込み。
 *  検出は簡易パターンであり迂回可能 — bash はそもそも承認制が本線)
 */
export function execWriteIndicator(command: string): boolean {
  return (
    /(^|[^>])>{1,2}(?!&)\s*\S/.test(command) || // リダイレクト(> / >>)。2>&1 等のfd複製は除外
    /(?:^|[\s;&|("'`])(?:rm|mv|cp|del|erase|move|copy|tee|touch|mkdir|rmdir|rd|ren|rename)\b/i.test(command) ||
    /\bsed\b[^\n]*\s-[a-z]*i/i.test(command) || // sed -i(インプレース編集)
    /\b(?:Set-Content|Out-File|Add-Content|Remove-Item|Move-Item|Copy-Item|New-Item)\b/i.test(command) ||
    /\bgit\b[^\n]*\b(?:checkout|restore|reset|clean|apply|stash)\b/i.test(command) // 作業ツリーを書き換えるgit
  );
}
