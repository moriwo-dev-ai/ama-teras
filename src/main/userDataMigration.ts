import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * M17-1: リネーム(mycodex → amateras)に伴う userData 移行。
 * 新 userData に実データが無く、旧に実データがあれば旧→新へコピーする。
 * - 判定は「ディレクトリの存在」ではなく実データファイルの有無で行う
 *   (electron はキャッシュ用に新ディレクトリを起動直後に作るため、存在判定は誤る)
 * - コピーは実データのみ(Chromium のキャッシュ類は持ち込まない。旧アプリが
 *   起動中でもロック衝突しない)
 * - 旧ディレクトリは消さない(ロールバック用)。移行済みはマーカーで冪等化
 * - electron 非依存(パス注入)でテスト可能
 */

/** アプリが userData に置く実データ(これが1つでもあれば「使用中のプロファイル」とみなす) */
const DATA_ENTRIES = [
  'config.json',
  'secrets.json',
  'audit.jsonl',
  'mcp.json',
  'sessions',
  'plugin-cache',
] as const;

/**
 * コピー対象 = 実データ + 「Local State」。
 * Local State は Chromium が safeStorage(DPAPI)の暗号鍵(os_crypt.encrypted_key)を
 * 保持するファイルで、これを移行しないと secrets.json が新プロファイルの別鍵で
 * 復号不能になる(=APIキーが消えたように見える)。実データ判定には使わない
 * (electron が起動時に自動生成するため)
 */
const COPY_ENTRIES = [...DATA_ENTRIES, 'Local State'] as const;

const MIGRATED_MARKER = 'migrated-from-mycodex.json';

export function hasRealData(dir: string): boolean {
  return DATA_ENTRIES.some((name) => existsSync(join(dir, name)));
}

export interface MigrationResult {
  migrated: boolean;
  reason: 'done' | 'already-migrated' | 'new-has-data' | 'no-old-data' | 'error';
  detail?: string;
}

export function migrateUserData(oldDir: string, newDir: string): MigrationResult {
  try {
    if (existsSync(join(newDir, MIGRATED_MARKER))) {
      return { migrated: false, reason: 'already-migrated' };
    }
    // 両方に実データがある場合は新を優先(何もしない)
    if (hasRealData(newDir)) return { migrated: false, reason: 'new-has-data' };
    if (!hasRealData(oldDir)) return { migrated: false, reason: 'no-old-data' };

    mkdirSync(newDir, { recursive: true });
    const copied: string[] = [];
    for (const name of COPY_ENTRIES) {
      const src = join(oldDir, name);
      if (!existsSync(src)) continue;
      cpSync(src, join(newDir, name), { recursive: true });
      copied.push(name);
    }
    // 冪等化マーカー(secrets は safeStorage のマシン鍵なので同一PCなら移行後も復号可)
    writeFileSync(
      join(newDir, MIGRATED_MARKER),
      JSON.stringify({ from: oldDir, at: new Date().toISOString(), copied }, null, 2),
      'utf8',
    );
    return { migrated: true, reason: 'done', detail: copied.join(', ') };
  } catch (err) {
    // 移行失敗でも起動は止めない(新規プロファイルとして動く。旧データは無傷)
    return { migrated: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
