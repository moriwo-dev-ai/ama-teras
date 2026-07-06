import { describe, expect, it } from 'vitest';
import { catastrophicCommandReason, collectStringValues } from './autonomy';

describe('catastrophicCommandReason (M17-2 denylist)', () => {
  const denied = [
    'format c:',
    'format.com D: /fs:ntfs',
    'echo yes | diskpart /s script.txt',
    'mkfs.ext4 /dev/sda1',
    String.raw`dd if=/dev/zero of=\\.\PhysicalDrive0`,
    String.raw`del /s /q C:\Windows\System32`,
    String.raw`rd /s /q "C:\Program Files\App"`,
    String.raw`rmdir /S C:\Windows\Temp`,
    'rm -rf /c/Windows/System32',
    String.raw`rm -rf C:\Windows`,
    'rm -rf /',
    String.raw`powershell Remove-Item -Recurse -Force C:\Windows\Temp`,
    'reg delete HKLM\\SOFTWARE /f',
    'cipher /w:C',
    'bcdedit /deletevalue safeboot',
    'vssadmin delete shadows /all',
  ];

  for (const cmd of denied) {
    it(`拒否: ${cmd.slice(0, 50)}`, () => {
      expect(catastrophicCommandReason(cmd)).not.toBeNull();
    });
  }

  const allowed = [
    'npm run build',
    'git status && git log --oneline -5',
    'del build\\temp.txt', // ワークスペース相対の削除は通す
    'rd /s /q node_modules', // 相対パスの再帰削除も通す(システム領域でない)
    'rm -rf ./dist',
    'rm -rf src/generated',
    'echo format is a word in a sentence',
    'node -e "console.log(1)"',
    'python format_checker.py', // format を含むファイル名は誤検出しない
    'dir C:\\Windows', // 読み取りは対象外
    'type C:\\Windows\\system.ini',
    'reg query HKLM\\SOFTWARE',
    'npx vitest run',
  ];

  for (const cmd of allowed) {
    it(`許可: ${cmd.slice(0, 50)}`, () => {
      expect(catastrophicCommandReason(cmd)).toBeNull();
    });
  }
});

describe('collectStringValues', () => {
  it('ネストした入力から文字列を集める', () => {
    expect(collectStringValues({ command: 'a', opts: { cwd: 'b', n: 1 }, list: ['c'] }).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('非オブジェクトも安全', () => {
    expect(collectStringValues(null)).toEqual([]);
    expect(collectStringValues('x')).toEqual(['x']);
    expect(collectStringValues(42)).toEqual([]);
  });
});
