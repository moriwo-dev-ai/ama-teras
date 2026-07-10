import { describe, expect, it } from 'vitest';
import { execSanctuaryMention, execWriteIndicator, sanctuaryHitFor, sanctuaryHitsFor } from './sanctuary';

describe('M28-1: sanctuaryHitFor(聖域パス判定)', () => {
  const root = 'C:\\dev\\amateras';

  it('リポジトリ内の聖域パスを捕捉する(区切りゆれ込み)', () => {
    expect(sanctuaryHitFor('C:\\dev\\amateras\\src\\main\\evolution\\manager.ts', root)).toEqual({
      file: 'src/main/evolution/manager.ts',
      entry: 'src/main/evolution',
    });
    expect(sanctuaryHitFor('C:/dev/amateras/CLAUDE.md', root)?.entry).toBe('CLAUDE.md');
    expect(sanctuaryHitFor('C:\\dev\\amateras\\src\\main\\tools\\executor.ts', root)?.entry).toBe(
      'src/main/tools/executor.ts',
    );
  });

  it('リポジトリ内の非聖域・リポジトリ外の同名パスは対象外', () => {
    expect(sanctuaryHitFor('C:\\dev\\amateras\\README.md', root)).toBeNull();
    expect(sanctuaryHitFor('C:\\dev\\amateras\\src\\main\\core\\service.ts', root)).toBeNull();
    // 他プロジェクトの CLAUDE.md / evolution ディレクトリは聖域扱いしない
    expect(sanctuaryHitFor('C:\\other\\proj\\CLAUDE.md', root)).toBeNull();
    expect(sanctuaryHitFor('C:\\other\\proj\\src\\main\\evolution\\x.ts', root)).toBeNull();
  });

  it('複数パスはヒットのみ返す', () => {
    const hits = sanctuaryHitsFor(
      ['C:\\dev\\amateras\\README.md', 'C:\\dev\\amateras\\src\\main\\secrets.ts'],
      root,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry).toBe('src/main/secrets.ts');
  });
});

describe('M28-1: exec系の簡易検出', () => {
  it('聖域パスの言及を検出する(\\ 区切り・大文字も)', () => {
    expect(execSanctuaryMention('echo x > src/main/evolution/protected.ts')).toBe('src/main/evolution');
    expect(execSanctuaryMention('type SRC\\MAIN\\SECRETS.TS')).toBe('src/main/secrets.ts');
    expect(execSanctuaryMention('cat CLAUDE.md')).toBe('CLAUDE.md');
    expect(execSanctuaryMention('npm run typecheck')).toBeNull();
    // executor.test.ts は executor.ts の言及ではない(部分一致だが連続文字列として不成立)
    expect(execSanctuaryMention('npx vitest run src/main/tools/executor.scope.test.ts')).toBeNull();
  });

  it('書き込み指標: リダイレクト・削除/移動・sed -i・PowerShell・git作業ツリー系', () => {
    expect(execWriteIndicator('echo x > file.ts')).toBe(true);
    expect(execWriteIndicator('cat a >> b')).toBe(true);
    expect(execWriteIndicator('rm -rf dir')).toBe(true);
    expect(execWriteIndicator('mv a b')).toBe(true);
    expect(execWriteIndicator("sed -i 's/a/b/' f.ts")).toBe(true);
    expect(execWriteIndicator('Set-Content -Path f -Value x')).toBe(true);
    expect(execWriteIndicator('git checkout -- .')).toBe(true);
  });

  it('読み取り系・fd複製は書き込み指標ではない', () => {
    expect(execWriteIndicator('grep -rn pattern src/')).toBe(false);
    expect(execWriteIndicator('npx vitest run src/main/evolution/manager.test.ts')).toBe(false);
    expect(execWriteIndicator('npm run typecheck 2>&1')).toBe(false);
    expect(execWriteIndicator('git log --oneline')).toBe(false);
    expect(execWriteIndicator('git diff HEAD~1')).toBe(false);
  });
});
