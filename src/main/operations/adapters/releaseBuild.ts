import type { AdapterRuntime } from '../protocol';

/**
 * M92-A7: リリース下書きの「ビルド+添付」を岩戸ゲート越しに1回で実行する。
 *
 * これまで欠けていたのは、リリースの前後(ノート下書き=github release / 公開=release-publish)の
 * **間の "インストーラをビルドして下書きに添付する" 手作業**だった。ここを scripts/release.mjs に
 * 一本化して(--publish 無し=下書き止まり)、承認を通ったexecutorだけが実行できるようにする。
 *
 * 大原則どおり executor は岩戸ゲートに封印される。承認ダイアログには「何のバージョンを・どこへ・
 * 公開はしない」ことを全文で出す。**公開(全利用者へ更新バナー)は別アクション(release-publish)**。
 *
 * この機能は開発版限定 — 配布版はソースツリー+ビルドtoolchainを持たないので自分をビルドできない。
 * よって runner が注入されない環境ではアダプタ自体を登録しない(= build-draft は存在しない)。
 */

/**
 * scripts/release.mjs を --publish 無しで回す実体。ipc.ts が注入する(開発版のみ)。
 * version は '1.2.3'(v無し)。notesBody はリリースノート全文。workspace はビルド対象リポジトリ。
 * 戻り値の output は成否によらずログ全文(失敗時は承認ダイアログ後のエラー表示に使う)。
 */
export type ReleaseBuildRunner = (args: {
  version: string;
  notesBody: string;
  workspace: string;
}) => Promise<{ ok: boolean; output: string }>;

export function createReleaseBuildAdapter(run: ReleaseBuildRunner): AdapterRuntime {
  return {
    id: 'release-build',
    capabilities: { read: true, search: false, draft: false, execute: ['build-draft'] },
    compliance:
      'ローカルでインストーラをビルドし GitHub Release の下書きに添付する(公開はしない)。開発版限定・承認必須',
    executor: async (action, params) => {
      if (action !== 'build-draft') throw new Error(`未対応のアクション: ${action}`);
      const version = String(params['version'] ?? '');
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`不正なバージョン: ${version}`);
      const notesBody = String(params['notesBody'] ?? '');
      const workspace = String(params['workspace'] ?? '');
      if (workspace === '') throw new Error('workspace が未設定(ビルド対象が分からない)');

      const r = await run({ version, notesBody, workspace });
      if (!r.ok) {
        // 失敗ログの末尾(原因が出やすい)を承認済みユーザーへ返す。握りつぶさない
        throw new Error(`ビルド/添付に失敗した:\n${r.output.slice(-1500)}`);
      }
      return `v${version} の下書きリリースをビルドし、インストーラを添付した(公開はまだ)`;
    },
  };
}
