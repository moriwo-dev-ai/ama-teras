import type { PluginManifest, PluginPermissions } from '../../shared/types';
import { isSafeToolName } from '../tools/name';

/**
 * M27-4: プラグインマニフェストの検証(REGISTRY_DESIGN.md 準拠)。
 * ローカルのエクスポート/インポートと、将来のレジストリCIの両方で使う共通ロジック。
 */

/** AGPL互換として受け入れるライセンス(SPDX)。投稿時DCO同意の前提 */
export const AGPL_COMPATIBLE_LICENSES = [
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'Unlicense',
  'CC0-1.0',
] as const;

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** "^1" / "~1.2" / "1" / "1.0.0" 形式のみ(範囲解釈は versioning 側の担当) */
const API_RANGE_RE = /^[\^~]?\d+(\.\d+){0,2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

/** manifest.json の中身を検証して型付きで返す。エラーは全件まとめて返す(直しやすさ優先) */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['manifest がオブジェクトではない'] };

  const name = raw['name'];
  if (!isSafeToolName(name)) {
    errors.push('name はツール名規則(英数字・_・-、1〜64文字)を満たす文字列であること');
  }
  const version = raw['version'];
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    errors.push('version は semver(例 1.0.0)であること');
  }
  const apiVersion = raw['pluginApiVersion'];
  if (typeof apiVersion !== 'string' || !API_RANGE_RE.test(apiVersion)) {
    errors.push('pluginApiVersion は "^1" のような範囲指定であること');
  }
  const description = raw['description'];
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push('description は空でない文字列であること');
  }
  const author = raw['author'];
  if (typeof author !== 'string') {
    errors.push('author は文字列であること(空文字は可)');
  }
  const license = raw['license'];
  if (
    typeof license !== 'string' ||
    !(AGPL_COMPATIBLE_LICENSES as readonly string[]).includes(license)
  ) {
    errors.push(
      `license はAGPL互換のSPDX ID であること(受入: ${AGPL_COMPATIBLE_LICENSES.join(', ')})`,
    );
  }

  const permsRaw = raw['permissions'];
  let permissions: PluginPermissions | null = null;
  if (
    isRecord(permsRaw) &&
    typeof permsRaw['network'] === 'boolean' &&
    typeof permsRaw['childProcess'] === 'boolean' &&
    (permsRaw['fsScope'] === 'none' || permsRaw['fsScope'] === 'workspace')
  ) {
    permissions = {
      network: permsRaw['network'],
      childProcess: permsRaw['childProcess'],
      fsScope: permsRaw['fsScope'],
    };
  } else {
    errors.push('permissions は { network: boolean, childProcess: boolean, fsScope: "none"|"workspace" } であること');
  }

  const deps = raw['dependencies'];
  if (!Array.isArray(deps) || deps.length !== 0) {
    // フェーズ1: 外部依存ゼロルール(サプライチェーンリスクの遮断)
    errors.push('dependencies は空配列であること(フェーズ1は外部npm依存ゼロがルール)');
  }

  let smoke: { input: unknown } | undefined;
  const smokeRaw = raw['smoke'];
  if (smokeRaw !== undefined) {
    if (isRecord(smokeRaw) && 'input' in smokeRaw) smoke = { input: smokeRaw['input'] };
    else errors.push('smoke は { input: <スモークテスト入力> } であること(省略可)');
  }

  if (errors.length > 0 || permissions === null) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      name: name as string,
      version: version as string,
      pluginApiVersion: apiVersion as string,
      description: description as string,
      author: author as string,
      license: license as string,
      permissions,
      dependencies: [],
      ...(smoke !== undefined ? { smoke } : {}),
    },
  };
}
