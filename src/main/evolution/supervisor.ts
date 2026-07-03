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
