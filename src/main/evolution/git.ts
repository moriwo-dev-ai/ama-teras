import { execFile } from 'node:child_process';

/** git CLI 薄ラッパ。失敗時は stderr 込みで例外 */
export async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} 失敗: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}
