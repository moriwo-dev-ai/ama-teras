import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeToolName } from '../tools/name';
import { defaultRunCommand, type CommandRunner } from './gates';

/**
 * 昇格後の健全性チェック: A(稼働リポジトリ)で昇格したツールのスモークを再実行する。
 * プラグインのみの変更ならAの動的リロードで反映済みのため、headless起動1回で足りる。
 * 失敗時は EvolutionManager が直前タグへ自動revertする。
 */
export async function healthCheckAfterPromotion(
  repoDir: string,
  toolName: string,
  smokeInput: unknown,
  runCommand: CommandRunner = defaultRunCommand,
): Promise<boolean> {
  assertSafeToolName(toolName); // shell 補間前の防御(gates と同じ理由)
  const dir = await mkdtemp(join(tmpdir(), 'mycodex-health-'));
  const inputPath = join(dir, 'input.json');
  await writeFile(inputPath, JSON.stringify(smokeInput ?? {}), 'utf8');
  const { code } = await runCommand(
    `npx electron . --tool ${toolName} --input "${inputPath}"`,
    repoDir,
    { MYCODEX_SMOKE: '1' },
  );
  return code === 0;
}

/**
 * M20: renderer/core 昇格後の再ビルド+フルアプリ健全性チェック(Aで実行)。
 * この間、稼働中アプリは旧バンドルのまま動作継続する(=健全性が確定するまで再起動しない)。
 * --smoke-boot は単一インスタンスロック非取得+userData隔離のため、稼働中Aと安全に並走できる。
 * 失敗時は EvolutionManager が自動revert+再ビルドし、アプリ無停止のまま rolled_back で完結する
 */
export async function rebuildAndHealthBoot(
  repoDir: string,
  runCommand: CommandRunner = defaultRunCommand,
): Promise<{ ok: boolean; output: string }> {
  const build = await runCommand('npm run build', repoDir);
  if (build.code !== 0) return { ok: false, output: `再ビルド失敗: ${build.output.slice(-2000)}` };
  const boot = await runCommand('npx electron . --smoke-boot', repoDir, { MYCODEX_SMOKE: '1' });
  if (boot.code !== 0) {
    return { ok: false, output: `フルアプリ健全性チェック失敗: ${boot.output.slice(-2000)}` };
  }
  return { ok: true, output: '再ビルド+健全性チェック合格' };
}
