import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvolutionJobRunner, EvolutionRequest, JobArtifacts } from '../evolution/job';
import { inspectImportDir } from './packager';

/**
 * M27-4: プラグインインポートの「生成」ステップ。
 * LLM生成の代わりに、検査済みディレクトリのコード+テストを B worktree の
 * プラグインディレクトリへコピーする。以降(検証ゲート→承認→昇格→ロールバック)は
 * 既存の進化パイプライン(EvolutionManager)がそのまま担う=**ゲートの省略なし**。
 */
export class ImportJobRunner implements EvolutionJobRunner {
  async generate(
    req: EvolutionRequest,
    worktreeDir: string,
    log: (line: string) => void,
    _signal: AbortSignal,
    feedback?: string,
  ): Promise<JobArtifacts> {
    if (req.importFrom === undefined) {
      throw new Error('importFrom が指定されていない(ImportJobRunner の呼び出し誤り)');
    }
    // 再生成(2回目)しても同じファイルのコピーで結果は変わらない → 即失敗させる
    if (feedback !== undefined) {
      throw new Error(`インポートしたプラグインが検証ゲート不合格: ${feedback.slice(0, 800)}`);
    }
    // enqueue前にも検査済みだが、時間差での改変に備えてコピー直前に再検査する
    const inspection = await inspectImportDir(req.importFrom);
    if (!inspection.ok || inspection.manifest === undefined || inspection.codePath === undefined) {
      throw new Error(`インポート元の検査に失敗: ${inspection.errors.join(' / ')}`);
    }
    const m = inspection.manifest;
    log(`インポート: ${m.name}@${m.version}(author: ${m.author || '不明'} / license: ${m.license})`);
    log(
      `権限宣言: network=${m.permissions.network} childProcess=${m.permissions.childProcess} fsScope=${m.permissions.fsScope}`,
    );
    for (const w of inspection.warnings) log(`⚠ ${w}`);

    const pluginsDir = join(worktreeDir, 'src', 'main', 'tools', 'plugins');
    await copyFile(inspection.codePath, join(pluginsDir, `${m.name}.ts`));
    if (inspection.testPath !== undefined) {
      await copyFile(inspection.testPath, join(pluginsDir, `${m.name}.test.ts`));
    }
    // M27-5: マニフェストも同梱する(<name>.manifest.json)。将来の本体APIメジャーアップ時、
    // loader が pluginApiVersion 範囲外のプラグインを「クラッシュではなく無効化+理由表示」できる
    await copyFile(join(req.importFrom, 'manifest.json'), join(pluginsDir, `${m.name}.manifest.json`));
    log(`B環境へコピー完了。検証ゲート(typecheck→vitest→スモーク)へ進む`);
    return { toolName: m.name, smokeInput: m.smoke?.input ?? {} };
  }
}

/**
 * 依頼の種類でランナーを振り分ける(importFrom あり=インポート、なし=LLM生成)。
 * ipc.ts の EvolutionManager 配線で使う(テスト可能にするため純粋な合成関数にしてある)
 */
export function composeRunners(
  generator: EvolutionJobRunner,
  importer: EvolutionJobRunner,
): EvolutionJobRunner {
  return {
    generate: (req, worktreeDir, log, signal, feedback) =>
      (req.importFrom !== undefined ? importer : generator).generate(
        req,
        worktreeDir,
        log,
        signal,
        feedback,
      ),
  };
}
