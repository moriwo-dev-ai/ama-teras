import { execFile } from 'node:child_process';
import type { WorkspaceGitStatus } from '../../shared/types';

/**
 * M15-4: 環境ウィジェット用の軽量git状態。git の無い workspace では isGit: false。
 * 失敗はすべて「git無し」へ縮退(ウィジェットは非表示になるだけ)。
 */
export async function workspaceGitStatus(dir: string): Promise<WorkspaceGitStatus> {
  const git = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: dir, windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return { isGit: false };
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '(detached)');
    const porcelain = await git(['status', '--porcelain']).catch(() => '');
    return {
      isGit: true,
      branch,
      dirtyCount: porcelain === '' ? 0 : porcelain.split('\n').filter((l) => l.trim() !== '').length,
    };
  } catch {
    return { isGit: false };
  }
}
