import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterRuntime } from '../protocol';
import { defaultGitRunner, type GitRunner } from './zennRepo';

/**
 * M47: リリース時に package.json の version を上げてコミット・push する。
 *
 * なぜ必要か: 更新確認(M42-1)は「package.json の version」と「GitHubの最新リリースタグ」を
 * 比べる。リリースだけ出して version を上げ忘れると、**自分のアプリに「新しい版があります」の
 * バナーが出続け**、利用者には正しく出ない。人間が毎回覚えておく作業なので機械にやらせる。
 *
 * 大原則どおり executor は岩戸ゲートに封印される。承認ダイアログには
 * 「どのファイルを・何から何へ・どのブランチへ push するか」を全文で出す。
 */

export interface VersionBumpPlan {
  /** リポジトリのルート(package.json がある場所) */
  dir: string;
  from: string;
  to: string;
}

/** package.json の version を読む。読めない/無ければ null(呼び出し側は自動更新を諦める) */
export function readPackageVersion(dir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const v = (raw as Record<string, unknown> | null)?.['version'];
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/**
 * version 行だけを書き換える(JSON.parse → stringify で全体を整形し直すと、
 * インデントやキー順が変わって差分が汚れるため、行単位で最小の置換にする)
 */
export function bumpVersionText(packageJson: string, to: string): string | null {
  const re = /("version"\s*:\s*")([^"]+)(")/;
  if (!re.test(packageJson)) return null;
  return packageJson.replace(re, `$1${to}$3`);
}

/** 'v1.2.3' → '1.2.3'(package.json の version は v を付けない) */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/, '');
}

export function createRepoVersionAdapter(dir: string, run: GitRunner = defaultGitRunner()): AdapterRuntime {
  return {
    id: 'repo-version',
    capabilities: { read: true, search: false, draft: false, execute: ['bump'] },
    compliance: 'ローカルのgitリポジトリを操作する(package.json の version 更新→コミット→push)。承認必須',
    executor: async (action, params) => {
      if (action !== 'bump') throw new Error(`未対応のアクション: ${action}`);
      const to = String(params['to'] ?? '');
      if (!/^\d+\.\d+\.\d+$/.test(to)) throw new Error(`不正なバージョン: ${to}`);

      const path = join(dir, 'package.json');
      const before = readFileSync(path, 'utf8');
      const after = bumpVersionText(before, to);
      if (after === null) throw new Error('package.json に version が見つからない');
      if (after === before) return `package.json はすでに ${to}(変更なし)`;

      // 事故防止: 他の変更が混ざったまま push しない(package.json だけを明示ステージング)
      writeFileSync(path, after, 'utf8');
      await run(['add', 'package.json'], dir);
      await run(['commit', '-m', `chore: bump version to ${to}`], dir);
      const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
      await run(['push', 'origin', branch], dir);
      return `package.json を ${to} に更新し、${branch} へ push した`;
    },
  };
}
