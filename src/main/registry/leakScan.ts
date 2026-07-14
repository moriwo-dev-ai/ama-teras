/**
 * M91-2: 外に出す前の機械チェック。人間は「見た」つもりで秘密を見落とす
 * (承認ダイアログに全文を出しても、APIキーが1行紛れているのを毎回見つけられるとは限らない)。
 * ここで拾うのは「出したら取り返しがつかないもの」だけ:
 *   - 資格情報らしき文字列(各社のキー形式・PEM・Bearer)
 *   - ローカルの絶対パス(ユーザー名が漏れる。C:\Users\<名前> は個人特定に足りる)
 */

export interface LeakFinding {
  kind: 'secret' | 'path';
  detail: string;
  /** 該当行(秘密そのものは伏せる) */
  line: number;
}

const SECRET_PATTERNS: { re: RegExp; detail: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/, detail: 'Anthropic APIキーらしき文字列' },
  { re: /sk-[A-Za-z0-9]{32,}/, detail: 'OpenAI APIキーらしき文字列' },
  { re: /gsk_[A-Za-z0-9]{20,}/, detail: 'Groq APIキーらしき文字列' },
  { re: /AIza[0-9A-Za-z_-]{30,}/, detail: 'Google APIキーらしき文字列' },
  { re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, detail: 'GitHubトークンらしき文字列' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, detail: 'Slackトークンらしき文字列' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, detail: '秘密鍵(PEM)' },
  { re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i, detail: 'Bearerトークンを含むヘッダ' },
  { re: /"?(api[_-]?key|password|passwd|secret|token)"?\s*[:=]\s*["'][^"'\s]{12,}["']/i, detail: '資格情報らしきキー=値' },
];

/** ユーザー名が露出する絶対パス(Windows/macOS/Linux) */
const PATH_PATTERNS: { re: RegExp; detail: string }[] = [
  { re: /[A-Za-z]:\\+Users\\+[^\\\s"']+/, detail: 'Windowsのユーザーパス(ユーザー名が露出する)' },
  { re: /\/Users\/[^/\s"']+/, detail: 'macOSのユーザーパス(ユーザー名が露出する)' },
  { re: /\/home\/[^/\s"']+/, detail: 'Linuxのユーザーパス(ユーザー名が露出する)' },
];

/** 出す前に見る。1件でも返ってきたら、そのままでは出さない */
export function scanForLeaks(text: string): LeakFinding[] {
  const findings: LeakFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) findings.push({ kind: 'secret', detail: p.detail, line: i + 1 });
    }
    for (const p of PATH_PATTERNS) {
      if (p.re.test(line)) findings.push({ kind: 'path', detail: p.detail, line: i + 1 });
    }
  });
  return findings;
}

export function formatLeaks(findings: LeakFinding[]): string {
  return findings.map((f) => `${f.line}行目: ${f.detail}`).join('\n');
}
