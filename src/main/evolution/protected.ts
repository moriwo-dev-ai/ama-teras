import type { EvolutionGateResult } from '../../shared/types';
import { runGit } from './git';

/**
 * M20-1: 聖域(保護領域)の正本。docs/PROTECTED.md と一致させること(同期テストで固定)。
 *
 * 【不変条件(ユーザー承認済み・2026-07-06)— 変更禁止】
 * 保護判定は、稼働中A側のメモリ上 PROTECTED_PATHS 定数(このモジュールをAのバンドルから
 * import したもの)のみで行う。worktree B側の protected.ts を require/import して判定に
 * 使うことを絶対に禁止する(このファイルに動的import/requireが無いことをテストで固定)。
 * これにより、Bの protected.ts をどう改竄しても(空リスト化・判定無効化)、判定はA側の
 * リストで行われ、src/main/evolution エントリ自体が改竄diffを捕捉する。
 *
 * このファイル自身が src/main/evolution 配下=聖域内であり、
 * PROTECTED_PATHS を減らす・無効化する差分も同エントリで reject される(自己参照ガード)。
 */
export const PROTECTED_PATHS: readonly string[] = [
  /** 進化サブシステム全体(このファイル・guardrailsテストを内包) */
  'src/main/evolution',
  /** 承認ブローカー */
  'src/main/agent/approval.ts',
  /** 承認UI(ApprovalDialog 等) */
  'src/renderer/src/components/Approval',
  /** 承認IPCの受け口(approval:respond の写像を含むため全体を聖域化) */
  'src/main/ipc.ts',
  /** contextBridge(承認応答の経路) */
  'src/preload',
  /** IPCチャネル名の定義(approvalRespond 等を含む) */
  'src/shared/ipc.ts',
  /** 鍵素材 */
  'src/main/secrets.ts',
  /** safeStorage / Local State(鍵素材)移行 */
  'src/main/userDataMigration.ts',
  /** プロジェクト規約 */
  'CLAUDE.md',
  /** 聖域リストの文書(正本の写し) */
  'docs/PROTECTED.md',
];

/**
 * ファイルパス(リポジトリルート相対)が聖域内なら該当エントリを返す。聖域外は null。
 * - 区切りは / \ 混在を許容、大文字小文字非依存(Windows前提+表記ゆれ悪用の防止)
 * - prefix境界を強制('src/main/evolution' は 'src/main/evolutionX.ts' にマッチしない)
 */
export function isProtectedFile(file: string): string | null {
  const norm = file.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  for (const p of PROTECTED_PATHS) {
    const prefix = p.toLowerCase().replace(/\/+$/, '');
    if (norm === prefix || norm.startsWith(`${prefix}/`)) return p;
  }
  return null;
}

/** 差分ファイル一覧から聖域違反を列挙する(純関数・テスト用に公開) */
export function findProtectedViolations(files: string[]): { file: string; entry: string }[] {
  const out: { file: string; entry: string }[] = [];
  for (const file of files) {
    if (file.trim() === '') continue;
    const entry = isProtectedFile(file);
    if (entry !== null) out.push({ file, entry });
  }
  return out;
}

/**
 * ゲート0(全ゲートの最初・無条件): 聖域トリップワイヤ。
 * baseRef...branch の差分が聖域に1ファイルでも触れたら即 reject。
 * 呼び出し側(manager)は不合格時に再生成もせず、承認ダイアログも出さずにジョブを終了する。
 * git は常に A(repoDir)で実行する — Bのファイル内容は判定に一切使わない。
 */
export async function checkProtectedTripwire(
  repoDir: string,
  baseRef: string,
  branch: string,
): Promise<EvolutionGateResult> {
  // --no-renames: リネームを ADD+DELETE に分解し、聖域からの持ち出し(旧パス)も必ずリストさせる
  const out = await runGit(['diff', '--name-only', '--no-renames', `${baseRef}...${branch}`], repoDir);
  const files = out === '' ? [] : out.split('\n');
  const violations = findProtectedViolations(files);
  if (violations.length > 0) {
    return {
      name: 'protected',
      ok: false,
      detail: `聖域への変更を検出(即reject・承認ダイアログ非表示): ${violations
        .map((v) => `${v.file} [${v.entry}]`)
        .join(', ')}`,
    };
  }

  // シンボリックリンクの新規/変更(mode 120000)は内容に関わらず拒否する。
  // 聖域外に置いたリンク経由でビルド時に聖域実体へ到達する迂回を構造的に塞ぐ
  const raw = await runGit(['diff', '--raw', '--no-renames', `${baseRef}...${branch}`], repoDir);
  const symlinkLines = raw
    .split('\n')
    .filter((l) => /^:\d{6} 120000 /.test(l) || /^:120000 \d{6} /.test(l));
  if (symlinkLines.length > 0) {
    return {
      name: 'protected',
      ok: false,
      detail: `シンボリックリンクの追加/変更を検出(進化ジョブでは禁止): ${symlinkLines
        .map((l) => l.split('\t').pop() ?? l)
        .join(', ')}`,
    };
  }

  return { name: 'protected', ok: true, detail: `聖域への変更なし(${files.length}ファイル検査)` };
}
