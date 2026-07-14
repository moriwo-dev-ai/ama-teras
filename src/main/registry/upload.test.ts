import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, type GateEvidence } from '../evolution/local';
import { repoFromRegistryUrl } from './github';
import { scanForLeaks } from './leakScan';
import { buildUploadPlan, submitUpload, uploadPreviewText, verificationState } from './upload';

/**
 * M91-2: 公開経路。守りたいのは3つ:
 *  1. 検証を通っていないもの・検証後に書き換えたものは出せない
 *  2. 送信前に全文が人間に見える(承認の対象は「これから送る中身そのもの」)
 *  3. 秘密・ローカルパスは機械が止める(人間の目視は漏らす)
 */

const CODE = `import type { ToolPlugin } from '../types';
export function shout(t: string): string {
  return t.toUpperCase();
}
const plugin: ToolPlugin = {
  name: 'shout_text',
  description: '大文字にする',
  risk: 'safe',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(input) {
    return { content: shout(String((input as { text?: string }).text ?? '')), isError: false };
  },
};
export default plugin;
`;
const TEST = "import { expect, it } from 'vitest';\nimport { shout } from './shout_text';\nit('x', () => expect(shout('a')).toBe('A'));\n";

let dir: string;

const writeEvidence = async (code: string, ok = true): Promise<void> => {
  const evidence: GateEvidence = {
    toolName: 'shout_text',
    ok,
    gates: [
      { name: 'inspect', ok: true, detail: '検査OK' },
      { name: 'typecheck', ok: true, detail: '型検査OK' },
      { name: 'test', ok: true, detail: '1件のテストが通った' },
      { name: 'smoke', ok: true, detail: '1回実行できた' },
    ],
    pluginApiVersion: '1.0.0',
    codeHash: await sha256(code),
    verifiedAt: '2026-07-15T00:00:00.000Z',
    by: 'local',
  };
  await writeFile(join(dir, 'shout_text.gate.json'), JSON.stringify(evidence), 'utf8');
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-upload-'));
  await writeFile(join(dir, 'shout_text.ts'), CODE, 'utf8');
  await writeFile(join(dir, 'shout_text.test.ts'), TEST, 'utf8');
  await writeFile(
    join(dir, 'shout_text.manifest.json'),
    JSON.stringify({ name: 'shout_text', version: '1.0.0', description: '大文字にする' }),
    'utf8',
  );
  await writeEvidence(CODE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const REGISTRY = 'https://raw.githubusercontent.com/moriwo-dev-ai/amateras-registry/main';

/** index.json を返すだけの fetch(実ネットワークには出ない) */
const fakeFetch = ((url: string) =>
  Promise.resolve(
    new Response(JSON.stringify({ registryVersion: 1, plugins: [{ name: 'text_stats' }], gods: [] }), {
      status: url.endsWith('index.json') ? 200 : 404,
    }),
  )) as unknown as typeof fetch;

describe('repoFromRegistryUrl', () => {
  it('raw.githubusercontent.com からオーナー/リポジトリ/ブランチを取る', () => {
    expect(repoFromRegistryUrl(REGISTRY)).toEqual({
      owner: 'moriwo-dev-ai',
      repo: 'amateras-registry',
      branch: 'main',
    });
  });
  it('github.com のURLでも取れる', () => {
    expect(repoFromRegistryUrl('https://github.com/acme/reg')).toEqual({
      owner: 'acme',
      repo: 'reg',
      branch: 'main',
    });
  });
  it('GitHub以外は特定できない(黙って公式へ送ったりしない)', () => {
    expect(repoFromRegistryUrl('https://registry.example.com/plugins')).toBeNull();
  });
});

describe('verificationState(未検証タグの根拠)', () => {
  it('証跡があり、コードが一致していれば verified', async () => {
    expect((await verificationState(dir, 'shout_text')).state).toBe('verified');
  });

  it('証跡が無ければ unverified(手で置いたプラグインは公開できない)', async () => {
    await rm(join(dir, 'shout_text.gate.json'));
    const v = await verificationState(dir, 'shout_text');
    expect(v.state).toBe('unverified');
  });

  it('検証後にコードを書き換えたら stale(検証していないものを検証済みと呼ばない)', async () => {
    await writeFile(join(dir, 'shout_text.ts'), `${CODE}\n// あとから足した1行\n`, 'utf8');
    const v = await verificationState(dir, 'shout_text');
    expect(v.state).toBe('stale');
  });
});

describe('buildUploadPlan', () => {
  it('コード・テスト・マニフェスト・索引の4ファイルを組み、全文を下見に出す', async () => {
    const plan = await buildUploadPlan({
      pluginsDir: dir,
      toolName: 'shout_text',
      registryUrl: REGISTRY,
      author: 'someone',
      fetchFn: fakeFetch,
    });
    expect(plan.files.map((f) => f.path)).toEqual([
      'plugins/shout_text/shout_text.ts',
      'plugins/shout_text/shout_text.test.ts',
      'plugins/shout_text/manifest.json',
      'index.json',
    ]);
    // 索引には verified:false で載る(検証済みバッジはメンテナーが付ける)
    const index = JSON.parse(plan.files[3]!.content) as { plugins: { name: string; verified: boolean }[] };
    expect(index.plugins.find((p) => p.name === 'shout_text')?.verified).toBe(false);
    // 権限は宣言ではなく実装から起こす(CIの静的解析と食い違わせない)
    expect(plan.manifest.permissions).toEqual({ network: false, childProcess: false, fsScope: 'none' });
    expect(plan.commitMessage).toContain('Signed-off-by: someone');
    expect(uploadPreviewText(plan)).toContain('export function shout');
    expect(uploadPreviewText(plan)).toContain('moriwo-dev-ai/amateras-registry');
  });

  it('検証を通っていないものは組み立て自体を断る', async () => {
    await rm(join(dir, 'shout_text.gate.json'));
    await expect(
      buildUploadPlan({ pluginsDir: dir, toolName: 'shout_text', registryUrl: REGISTRY, author: 'x', fetchFn: fakeFetch }),
    ).rejects.toThrow(/公開できない/);
  });

  it('既にレジストリにある名前は断る(1 PR = 1 プラグイン、上書きしない)', async () => {
    const dup = ((url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ registryVersion: 1, plugins: [{ name: 'shout_text' }] }), {
          status: url.endsWith('index.json') ? 200 : 404,
        }),
      )) as unknown as typeof fetch;
    await expect(
      buildUploadPlan({ pluginsDir: dir, toolName: 'shout_text', registryUrl: REGISTRY, author: 'x', fetchFn: dup }),
    ).rejects.toThrow(/既に/);
  });
});

describe('秘密の機械チェック', () => {
  it('APIキー・ローカルパスを見つける', () => {
    const found = scanForLeaks(
      ['const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";', 'const p = "C:\\\\Users\\\\haru\\\\x";'].join('\n'),
    );
    expect(found.map((f) => f.kind)).toEqual(['secret', 'path']);
  });

  it('秘密が見つかったら送信しない(トークンがあっても出さない)', async () => {
    await writeFile(
      join(dir, 'shout_text.ts'),
      `${CODE}\nconst LEAK = 'ghp_0123456789abcdefghijklmnopqrstuvwx';\n`,
      'utf8',
    );
    await writeEvidence(`${CODE}\nconst LEAK = 'ghp_0123456789abcdefghijklmnopqrstuvwx';\n`);
    const plan = await buildUploadPlan({
      pluginsDir: dir,
      toolName: 'shout_text',
      registryUrl: REGISTRY,
      author: 'x',
      fetchFn: fakeFetch,
    });
    expect(plan.leaks.length).toBeGreaterThan(0);
    const r = await submitUpload(plan, 'token', { fetchFn: fakeFetch });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('秘密情報');
  });
});

describe('submitUpload(fork → ブランチ → PR)', () => {
  it('GitHub APIを順に叩き、PRのURLを返す', async () => {
    const calls: string[] = [];
    let forked = false; // フォークは非同期に作られる(最初は404、作成後に見える)
    const gh = ((url: string, init?: { method?: string }) => {
      const path = url.replace('https://api.github.com', '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (path === '/user') return Promise.resolve(json({ login: 'contributor' }));
      if (path === '/repos/contributor/amateras-registry') return Promise.resolve(json({}, forked ? 200 : 404));
      if (path === '/repos/moriwo-dev-ai/amateras-registry/forks') {
        forked = true;
        return Promise.resolve(json({}));
      }
      if (path.startsWith('/repos/moriwo-dev-ai/amateras-registry/git/ref/heads/'))
        return Promise.resolve(json({ object: { sha: 'base-sha' } }));
      if (path.startsWith('/repos/contributor/amateras-registry/git/refs')) return Promise.resolve(json({}));
      if (path.startsWith('/repos/contributor/amateras-registry/contents/'))
        return Promise.resolve(init?.method === 'PUT' ? json({}) : json({}, 404));
      if (path === '/repos/moriwo-dev-ai/amateras-registry/pulls')
        return Promise.resolve(json({ html_url: 'https://github.com/x/pull/7', number: 7 }));
      if (path.endsWith('index.json')) return Promise.resolve(json({ registryVersion: 1, plugins: [] }));
      return Promise.resolve(json({}, 404));
    }) as unknown as typeof fetch;

    const plan = await buildUploadPlan({
      pluginsDir: dir,
      toolName: 'shout_text',
      registryUrl: REGISTRY,
      author: 'contributor',
      fetchFn: fakeFetch,
    });
    const r = await submitUpload(plan, 'token', { fetchFn: gh, waitMs: 0, draft: true });

    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/x/pull/7');
    // 自分のフォークに作り、upstream へPRを出す(upstream に直接ブランチを作らない)
    expect(calls).toContain('POST /repos/moriwo-dev-ai/amateras-registry/forks');
    expect(calls.some((c) => c.startsWith('POST /repos/contributor/amateras-registry/git/refs'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('PUT /repos/contributor/')).length).toBe(plan.files.length);
    expect(calls).toContain('POST /repos/moriwo-dev-ai/amateras-registry/pulls');
  });
});
