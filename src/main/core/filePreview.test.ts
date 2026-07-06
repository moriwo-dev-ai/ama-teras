import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewFile, resolveRevealTarget, type FilePreviewPolicy } from './filePreview';

/** M15-3: ファイルプレビューの種別判定とスコープ制御を固定する */

let base: string;
let ws: string;
let outside: string;
let userData: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycodex-preview-'));
  ws = join(base, 'ws');
  outside = join(base, 'outside');
  userData = join(base, 'userdata');
  for (const d of [ws, outside, userData]) await mkdir(d, { recursive: true });
  await writeFile(join(ws, 'README.md'), '# タイトル\n本文', 'utf8');
  await writeFile(join(ws, 'main.ts'), 'const x = 1;', 'utf8');
  await writeFile(join(ws, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), null);
  await writeFile(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]), null);
  await writeFile(join(outside, 'note.md'), 'そと', 'utf8');
  await writeFile(join(userData, 'secrets.json'), '{}', 'utf8');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

function policy(mode: 'project' | 'fullPc'): FilePreviewPolicy {
  return { workspaceRoot: ws, scopeMode: mode, deny: { userDataDir: userData } };
}

describe('previewFile(M15-3)', () => {
  it('.md は markdown、コードは code、画像は dataUrl(相対パスはworkspace基準)', async () => {
    const md = await previewFile('README.md', policy('project'));
    expect(md).toMatchObject({ ok: true, kind: 'markdown' });
    expect(md.content).toContain('# タイトル');

    const code = await previewFile('main.ts', policy('project'));
    expect(code).toMatchObject({ ok: true, kind: 'code', content: 'const x = 1;' });

    const img = await previewFile(join(ws, 'icon.png'), policy('project'));
    expect(img.ok).toBe(true);
    expect(img.kind).toBe('image');
    expect(img.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('workspace外は project で拒否・fullPc で表示できる', async () => {
    const denied = await previewFile(join(outside, 'note.md'), policy('project'));
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('fullPc');

    const allowed = await previewFile(join(outside, 'note.md'), policy('fullPc'));
    expect(allowed.ok).toBe(true);
  });

  it('保護領域(userData)は fullPc でも拒否', async () => {
    const r = await previewFile(join(userData, 'secrets.json'), policy('fullPc'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('保護領域');
  });

  it('バイナリ・不在・ディレクトリは拒否', async () => {
    expect((await previewFile('bin.dat', policy('project'))).ok).toBe(false);
    expect((await previewFile('nai.md', policy('project'))).ok).toBe(false);
    expect((await previewFile('.', policy('project'))).ok).toBe(false);
  });
});

describe('resolveRevealTarget(整理1: フォルダで開く)', () => {
  it('workspace内のファイルもディレクトリも解決できる(相対パスはworkspace基準)', async () => {
    const file = await resolveRevealTarget('README.md', policy('project'));
    expect(file).toEqual({ ok: true, path: join(ws, 'README.md') });

    const dir = await resolveRevealTarget(ws, policy('project'));
    expect(dir).toEqual({ ok: true, path: ws });
  });

  it('workspace外でも解決できる(左ペインの他プロジェクト用。内容は読まないため)', async () => {
    const r = await resolveRevealTarget(outside, policy('project'));
    expect(r).toEqual({ ok: true, path: outside });
  });

  it('保護領域(userData)は拒否・不在パスと空文字も拒否', async () => {
    const denied = await resolveRevealTarget(join(userData, 'secrets.json'), policy('fullPc'));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.message).toContain('保護領域');

    expect((await resolveRevealTarget(join(base, 'nai'), policy('project'))).ok).toBe(false);
    expect((await resolveRevealTarget('  ', policy('project'))).ok).toBe(false);
  });
});
