/**
 * M17-2: 自律モードのカタストロフィック・コマンド判定(トリップワイヤ)。
 * bash 等の exec 系はどのパスに触るか静的に判定できないため、
 * 「自分と OS を再起不能にする」最小限のパターンだけを denylist で即拒否する。
 * それ以外の system コマンドは自律モードでは通す(残余リスクはユーザー了承済み・自己責任)。
 * 通常モード(承認制)ではこの判定は使わない — 人間の目視承認が防波堤のため。
 */

/** Windowsシステム領域・ドライブ直下を指す引数か(区切りは \ / 混在を許容) */
const SYSTEM_TARGET =
  String.raw`(?:[a-z]:[\\/](?:windows|program\s?files(?:\s?\(x86\))?)|[a-z]:[\\/]?\s*$|[a-z]:[\\/]?[\s"']|/c/(?:windows|program\s?files))`;

interface Rule {
  re: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { re: /(?:^|[\s;&|("'`])format(?:\.com)?\s+[a-z]:/i, reason: 'ドライブのフォーマット(format)' },
  { re: /(?:^|[\s;&|("'`])diskpart\b/i, reason: 'パーティション操作(diskpart)' },
  { re: /(?:^|[\s;&|("'`])mkfs(?:\.\w+)?\b/i, reason: 'ファイルシステム作成(mkfs)' },
  { re: /\bdd\b[^\n]*\bof=\\\\\.\\physicaldrive/i, reason: '物理ドライブへの直接書き込み(dd)' },
  {
    re: new RegExp(String.raw`(?:^|[\s;&|("'\`])(?:del|erase|rd|rmdir)\b[^\n&|;]*${SYSTEM_TARGET}`, 'i'),
    reason: 'システム領域・ドライブ直下の削除(del/rd)',
  },
  {
    re: new RegExp(
      String.raw`(?:^|[\s;&|("'\`])rm\b[^\n&|;]*\s-[a-z]*(?:rf|fr)[a-z]*\b[^\n&|;]*(?:${SYSTEM_TARGET}|\s/(?:\s|$))`,
      'i',
    ),
    reason: 'システム領域・ルートの再帰削除(rm -rf)',
  },
  {
    re: /(?:^|[\s;&|("'`])remove-item\b[^\n&|;]*-recurse[^\n&|;]*(?:c:[\\/](?:windows|program\s?files)|c:[\\/]?\s*$)/i,
    reason: 'システム領域の再帰削除(Remove-Item)',
  },
  { re: /(?:^|[\s;&|("'`])reg(?:\.exe)?\s+delete\s+hklm/i, reason: 'HKLMレジストリの削除(reg delete)' },
  { re: /(?:^|[\s;&|("'`])cipher\s+\/w/i, reason: 'ドライブの完全消去(cipher /w)' },
  { re: /(?:^|[\s;&|("'`])bcdedit\b[^\n]*\/delete/i, reason: 'ブート構成の削除(bcdedit)' },
  { re: /(?:^|[\s;&|("'`])vssadmin\b[^\n]*delete\s+shadows/i, reason: 'シャドウコピーの削除(vssadmin)' },
];

/**
 * カタストロフィックなコマンドなら拒否理由を返す。安全なら null。
 * 判定は保守的(誤検出よりも見逃し回避を優先)だが、通常の開発コマンド
 * (npm / git / del ワークスペース内 等)は引っかからないこと(テストで固定)。
 */
export function catastrophicCommandReason(command: string): string | null {
  for (const rule of RULES) {
    if (rule.re.test(command)) return rule.reason;
  }
  return null;
}

/** ツール入力(任意JSON)の中の文字列値を集める(exec系の command 検査用・ネスト対応) */
export function collectStringValues(input: unknown, depth = 0): string[] {
  if (depth > 4 || input === null || input === undefined) return [];
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.flatMap((v) => collectStringValues(v, depth + 1));
  if (typeof input === 'object') {
    return Object.values(input as Record<string, unknown>).flatMap((v) => collectStringValues(v, depth + 1));
  }
  return [];
}
