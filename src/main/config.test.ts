import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigStore,
  effectiveMaxTurns,
  effectiveModelPolicy,
  effectiveReviewGate,
  evolutionDisabledReason,
  parseModelPolicy,
  parseReviewGate,
} from './config';
import type { AppConfig } from '../shared/types';
import { DEFAULT_REGISTRY_URL, DEFAULT_UPDATE_CHECK_URL } from '../shared/models';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-config-'));
  file = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('ConfigStore', () => {
  it('ファイルが無ければ既定を返す', () => {
    const store = new ConfigStore(file);
    const c = store.get();
    expect(c.provider).toBe('anthropic');
    expect(c.model).toBe('');
    expect(c.workspace).toBeUndefined();
    expect(c.scopeMode).toBe('project');
  });

  it('set した内容が永続化され再読込で復元される(workspace含む)', () => {
    const store = new ConfigStore(file);
    store.set({
      autoApprove: { safe: true, write: true, exec: false },
      provider: 'openai',
      model: 'gpt-5.1',
      workspace: 'C:/work/proj',
      scopeMode: 'fullPc',
    });
    const reloaded = new ConfigStore(file);
    const c = reloaded.get();
    expect(c.provider).toBe('openai');
    expect(c.workspace).toBe('C:/work/proj');
    expect(c.autoApprove.write).toBe(true);
    expect(c.scopeMode).toBe('fullPc');
  });

  it('scopeMode が無い既存設定ファイルは project にフォールバック(後方互換)', async () => {
    await writeFile(file, JSON.stringify({ provider: 'openai', model: '' }));
    expect(new ConfigStore(file).get().scopeMode).toBe('project');
  });

  it('不正な scopeMode は project にフォールバック', async () => {
    await writeFile(file, JSON.stringify({ scopeMode: 'yolo' }));
    expect(new ConfigStore(file).get().scopeMode).toBe('project');
  });

  it('空文字の workspace は未設定として扱う', async () => {
    await writeFile(file, JSON.stringify({ provider: 'anthropic', model: '', workspace: '' }));
    const c = new ConfigStore(file).get();
    expect(c.workspace).toBeUndefined();
  });

  it('壊れたJSONは既定にフォールバック', async () => {
    await writeFile(file, '{ broken');
    const c = new ConfigStore(file).get();
    expect(c.provider).toBe('anthropic');
  });

  // ---- M11-1: maxTurns ----

  it('maxTurns の既定は未設定(=ループ側の既定30に委ねる・後方互換)', async () => {
    expect(new ConfigStore(file).get().maxTurns).toBeUndefined();
    await writeFile(file, JSON.stringify({ provider: 'openai', model: '' }));
    expect(new ConfigStore(file).get().maxTurns).toBeUndefined();
  });

  it('範囲外の maxTurns は 1〜200 にクランプして読み込む', async () => {
    await writeFile(file, JSON.stringify({ maxTurns: 0 }));
    expect(new ConfigStore(file).get().maxTurns).toBe(1);
    await writeFile(file, JSON.stringify({ maxTurns: 9999 }));
    expect(new ConfigStore(file).get().maxTurns).toBe(200);
    await writeFile(file, JSON.stringify({ maxTurns: 50 }));
    expect(new ConfigStore(file).get().maxTurns).toBe(50);
  });

  it('数値でない・非有限の maxTurns は未設定として扱う', async () => {
    await writeFile(file, JSON.stringify({ maxTurns: 'many' }));
    expect(new ConfigStore(file).get().maxTurns).toBeUndefined();
  });

  it('set 経由の maxTurns もクランプされ永続化される', () => {
    const store = new ConfigStore(file);
    const saved = store.set({ ...store.get(), maxTurns: 500 });
    expect(saved.maxTurns).toBe(200);
    expect(new ConfigStore(file).get().maxTurns).toBe(200);
  });

  // ---- M92-A5-a: generationModel ----

  it('generationModel は既定で未設定、設定すると set/load を往復して永続化される', async () => {
    const store = new ConfigStore(file);
    expect(store.get().generationModel).toBeUndefined();
    store.set({ ...store.get(), generationModel: 'claude-opus-4-8' });
    // 別インスタンスで読み直しても残る(load 側のホワイトリストに配線済み)
    expect(new ConfigStore(file).get().generationModel).toBe('claude-opus-4-8');
    // 空欄=本体と同じ(未設定へ正規化)
    const saved = store.set({ ...store.get(), generationModel: '  ' });
    expect(saved.generationModel).toBeUndefined();
    await writeFile(file, JSON.stringify({ generationModel: '' }));
    expect(new ConfigStore(file).get().generationModel).toBeUndefined();
  });

  // ---- M11-4: postEditHook ----

  it('postEditHook の既定は未設定(=無効)で、設定すると永続化される', () => {
    const store = new ConfigStore(file);
    expect(store.get().postEditHook).toBeUndefined();
    store.set({ ...store.get(), postEditHook: 'npx vitest run --changed' });
    expect(new ConfigStore(file).get().postEditHook).toBe('npx vitest run --changed');
  });

  it('空文字・空白のみの postEditHook は未設定に正規化される', async () => {
    const store = new ConfigStore(file);
    const saved = store.set({ ...store.get(), postEditHook: '   ' });
    expect(saved.postEditHook).toBeUndefined();
    await writeFile(file, JSON.stringify({ postEditHook: '' }));
    expect(new ConfigStore(file).get().postEditHook).toBeUndefined();
  });

  // ---- M10: remote 設定 ----

  it('remote の既定は disabled / port 8787 / トークン未発行', () => {
    const c = new ConfigStore(file).get();
    expect(c.remote).toEqual({ enabled: false, port: 8787 });
  });

  it('remote 設定(tokenHash 含む)が永続化される', () => {
    const store = new ConfigStore(file);
    const hash = 'a'.repeat(64);
    store.set({
      ...store.get(),
      remote: { enabled: true, port: 9000, tokenHash: hash },
    });
    const c = new ConfigStore(file).get();
    expect(c.remote).toEqual({ enabled: true, port: 9000, tokenHash: hash });
  });

  it('remote が無い既存設定ファイルは既定(disabled)にフォールバック(後方互換)', async () => {
    await writeFile(file, JSON.stringify({ provider: 'openai', model: '' }));
    expect(new ConfigStore(file).get().remote).toEqual({ enabled: false, port: 8787 });
  });

  it('不正な tokenHash(sha256 hex 以外)と不正な port は無視される', async () => {
    await writeFile(
      file,
      JSON.stringify({ remote: { enabled: true, port: 99999, tokenHash: 'plaintext-token' } }),
    );
    const c = new ConfigStore(file).get();
    expect(c.remote).toEqual({ enabled: true, port: 8787 });
  });

  // ---- M18: modelPolicy ----

  it('modelPolicy の既定は未設定(=無効・従来挙動)', async () => {
    expect(new ConfigStore(file).get().modelPolicy).toBeUndefined();
    await writeFile(file, JSON.stringify({ provider: 'openai', model: '' }));
    expect(new ConfigStore(file).get().modelPolicy).toBeUndefined();
  });

  it('modelPolicy が永続化され、maxEscalationsPerTask はクランプされる', () => {
    const store = new ConfigStore(file);
    store.set({
      ...store.get(),
      modelPolicy: {
        enabled: true,
        planner: { provider: 'anthropic', model: 'claude-fable-5' },
        worker: { provider: 'openai', model: 'gpt-5.1' },
        escalation: { provider: 'anthropic', model: 'claude-fable-5' },
        maxEscalationsPerTask: 99,
      },
    });
    const c = new ConfigStore(file).get();
    expect(c.modelPolicy?.enabled).toBe(true);
    expect(c.modelPolicy?.worker).toEqual({ provider: 'openai', model: 'gpt-5.1' });
    expect(c.modelPolicy?.maxEscalationsPerTask).toBe(3); // クランプ(0〜3)
  });

  it('壊れた modelPolicy(帯欠落・不正provider)は未設定=無効へフォールバック', async () => {
    await writeFile(
      file,
      JSON.stringify({ modelPolicy: { enabled: true, planner: { provider: 'gemini', model: 'x' } } }),
    );
    expect(new ConfigStore(file).get().modelPolicy).toBeUndefined();
    await writeFile(file, JSON.stringify({ modelPolicy: { enabled: true } }));
    expect(new ConfigStore(file).get().modelPolicy).toBeUndefined();
  });

  // ---- M19: reviewGate ----

  it('reviewGate の既定は未設定(=無効・従来挙動)', async () => {
    expect(new ConfigStore(file).get().reviewGate).toBeUndefined();
    await writeFile(file, JSON.stringify({ provider: 'openai', model: '' }));
    expect(new ConfigStore(file).get().reviewGate).toBeUndefined();
  });

  it('reviewGate が永続化され、threshold/rounds はクランプ・axes は欠落分true補完', () => {
    const store = new ConfigStore(file);
    store.set({
      ...store.get(),
      reviewGate: {
        enabled: true,
        threshold: 9,
        maxRoundsPerMilestone: 99,
        axes: { code: true, ux: false, requirements: true, tests: true },
      },
    });
    const c = new ConfigStore(file).get();
    expect(c.reviewGate?.enabled).toBe(true);
    expect(c.reviewGate?.threshold).toBe(5); // 1〜5クランプ
    expect(c.reviewGate?.maxRoundsPerMilestone).toBe(5); // 0〜5クランプ
    expect(c.reviewGate?.axes.ux).toBe(false);
  });

  it('parseReviewGate: enabledのみでも既定値(4.0/2/全軸true)で補完される', () => {
    const r = parseReviewGate({ enabled: true });
    expect(r).toEqual({
      enabled: true,
      threshold: 4.0,
      maxRoundsPerMilestone: 2,
      axes: { code: true, ux: true, requirements: true, tests: true },
    });
    expect(parseReviewGate({ threshold: 4 })).toBeNull(); // enabled欠落は無効
    expect(parseReviewGate('on')).toBeNull();
  });

  it('parseModelPolicy: escalation 未指定は省略のまま(planner 使用は呼び出し側の解釈)', () => {
    const p = parseModelPolicy({
      enabled: false,
      planner: { provider: 'anthropic', model: '' },
      worker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(p).toEqual({
      enabled: false,
      planner: { provider: 'anthropic', model: '' },
      worker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
  });

  it('M26-2: parseModelPolicy は reviewer 帯を保持し、壊れた reviewer は未指定へ落とす', () => {
    const base = {
      enabled: true,
      planner: { provider: 'anthropic', model: 'a' },
      worker: { provider: 'anthropic', model: 'b' },
    };
    const p = parseModelPolicy({ ...base, reviewer: { provider: 'openai', model: 'gpt-5.1' } });
    expect(p?.reviewer).toEqual({ provider: 'openai', model: 'gpt-5.1' });
    // 壊れた形(provider不正)は reviewer だけ落ちて policy 自体は生きる
    const broken = parseModelPolicy({ ...base, reviewer: { provider: 'gemini', model: 'x' } });
    expect(broken).not.toBeNull();
    expect(broken?.reviewer).toBeUndefined();
  });

  it('M26-3: parseModelPolicy は midEscalation / explorer を保持する', () => {
    const p = parseModelPolicy({
      enabled: true,
      planner: { provider: 'anthropic', model: 'a' },
      worker: { provider: 'anthropic', model: 'b' },
      midEscalation: { provider: 'anthropic', model: 'claude-opus-4-8' },
      explorer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(p?.midEscalation).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(p?.explorer).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('M26-1: parseReviewGate は passMode を保持し、3値以外は未指定(=severity扱い)へ正規化', () => {
    const base = { enabled: true, threshold: 4, maxRoundsPerMilestone: 2 };
    expect(parseReviewGate({ ...base, passMode: 'score' })?.passMode).toBe('score');
    expect(parseReviewGate({ ...base, passMode: 'severity' })?.passMode).toBe('severity');
    expect(parseReviewGate({ ...base, passMode: 'strict' })?.passMode).toBeUndefined();
    expect(parseReviewGate(base)?.passMode).toBeUndefined();
  });
});

describe('M27-1: 無料APIモード(providerPreset / freeMode)', () => {
  const base: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'openai',
    model: '',
    scopeMode: 'project',
  };

  it('ConfigStore が providerPreset / freeMode / freeModeAllowEvolution を永続化・復元する', () => {
    const store = new ConfigStore(file);
    store.set({ ...base, providerPreset: 'gemini', freeMode: true, freeModeAllowEvolution: true });
    const again = new ConfigStore(file).get();
    expect(again.providerPreset).toBe('gemini');
    expect(again.freeMode).toBe(true);
    expect(again.freeModeAllowEvolution).toBe(true);
  });

  it('不正な providerPreset は読み込み・保存の両方で未設定へ正規化される', async () => {
    await writeFile(file, JSON.stringify({ ...base, providerPreset: 'llamacpp', freeMode: 'yes' }), 'utf8');
    const store = new ConfigStore(file);
    expect(store.get().providerPreset).toBeUndefined();
    expect(store.get().freeMode).toBeUndefined(); // boolean以外は取り込まない

    const saved = store.set({ ...base, providerPreset: 'groq' });
    expect(saved.providerPreset).toBe('groq');
    const forced = store.set({ ...base, providerPreset: 'bad' as never });
    expect(forced.providerPreset).toBeUndefined();
  });

  it('effectiveMaxTurns: freeMode の既定は15、明示設定があればそちらを優先', () => {
    expect(effectiveMaxTurns(base)).toBeUndefined();
    expect(effectiveMaxTurns({ ...base, freeMode: true })).toBe(15);
    expect(effectiveMaxTurns({ ...base, freeMode: true, maxTurns: 40 })).toBe(40);
  });

  it('effectiveReviewGate / effectiveModelPolicy: freeMode 中は常に無効', () => {
    const review = { enabled: true, threshold: 4, maxRoundsPerMilestone: 2, axes: { code: true, ux: true, requirements: true, tests: true } };
    const policy = {
      enabled: true,
      planner: { provider: 'anthropic', model: 'a' },
      worker: { provider: 'anthropic', model: 'b' },
    } as const;
    const cfg: AppConfig = { ...base, reviewGate: review, modelPolicy: policy as never };
    expect(effectiveReviewGate(cfg)).toEqual(review);
    expect(effectiveModelPolicy(cfg)).toEqual(policy);
    const free: AppConfig = { ...cfg, freeMode: true };
    expect(effectiveReviewGate(free)).toBeUndefined();
    expect(effectiveModelPolicy(free)).toBeUndefined();
  });

  it('evolutionDisabledReason: freeMode 中のみ理由文、オプトインで解除', () => {
    expect(evolutionDisabledReason(base)).toBeNull();
    expect(evolutionDisabledReason({ ...base, freeMode: true })).toContain('無料モードでは新規生成は行えません');
    expect(evolutionDisabledReason({ ...base, freeMode: true, freeModeAllowEvolution: true })).toBeNull();
  });
});

describe('M29-4: registryUrl の既定値と正規化', () => {
  const base: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
  };

  it('未設定なら既定=公式レジストリURLが入る(新規・既存設定ファイル両方)', async () => {
    expect(new ConfigStore(file).get().registryUrl).toBe(DEFAULT_REGISTRY_URL);
    await writeFile(file, JSON.stringify({ ...base }), 'utf8');
    expect(new ConfigStore(file).get().registryUrl).toBe(DEFAULT_REGISTRY_URL);
  });

  it('空文字=検索無効は保持され、不正形式は既定へフォールバック', async () => {
    await writeFile(file, JSON.stringify({ ...base, registryUrl: '' }), 'utf8');
    expect(new ConfigStore(file).get().registryUrl).toBe('');
    await writeFile(file, JSON.stringify({ ...base, registryUrl: 'ftp://bad' }), 'utf8');
    expect(new ConfigStore(file).get().registryUrl).toBe(DEFAULT_REGISTRY_URL);
  });

  it('set() でも同じ正規化(カスタムURL保持・空文字保持・未設定/不正は既定へ)', () => {
    const store = new ConfigStore(file);
    expect(store.set({ ...base, registryUrl: 'https://internal.example/reg' }).registryUrl).toBe(
      'https://internal.example/reg',
    );
    expect(store.set({ ...base, registryUrl: '' }).registryUrl).toBe('');
    expect(store.set({ ...base }).registryUrl).toBe(DEFAULT_REGISTRY_URL);
    expect(store.set({ ...base, registryUrl: 'not-a-url' }).registryUrl).toBe(DEFAULT_REGISTRY_URL);
  });
});

describe('M41-5: operations の新フィールドが保存で消えないこと(実際に起きた事故)', () => {
  let dir2: string;
  let file2: string;
  beforeEach(async () => {
    dir2 = await mkdtemp(join(tmpdir(), 'cfg-ops-'));
    file2 = join(dir2, 'config.json');
  });
  afterEach(async () => {
    await rm(dir2, { recursive: true, force: true });
  });

  const ops = {
    enabled: true,
    repos: ['o/r'],
    zennSlugs: ['my-slug'],
    // M37/M41: parseOperationsConfig に無いフィールドは set() で消える。
    // zennRepoDir が落ちていたため「Zenn記事化」がUIで設定しても使えなかった
    zennRepoDir: 'C:\dev\zenn-content',
    projectName: 'my-tool',
    projectDescription: '個人開発のCLIツール',
    keywords: ['自作エージェント'],
    zennTopics: ['ai', 'typescript'],
  };

  it('set() でも read() でも zennRepoDir / プロジェクト像 / キーワード / topics が保持される', async () => {
    const store = new ConfigStore(file2);
    const saved = store.set({ ...store.get(), operations: ops });
    expect(saved.operations?.zennRepoDir).toBe('C:\dev\zenn-content');
    expect(saved.operations?.projectName).toBe('my-tool');
    expect(saved.operations?.projectDescription).toBe('個人開発のCLIツール');
    expect(saved.operations?.keywords).toEqual(['自作エージェント']);
    expect(saved.operations?.zennTopics).toEqual(['ai', 'typescript']);

    // 再ロード(=アプリ再起動)でも残る
    const reloaded = new ConfigStore(file2).get();
    expect(reloaded.operations?.zennRepoDir).toBe('C:\dev\zenn-content');
    expect(reloaded.operations?.projectName).toBe('my-tool');
    expect(reloaded.operations?.zennTopics).toEqual(['ai', 'typescript']);
  });

  it('空文字・空配列は未設定として落とす(嘘の設定値を持たない)', () => {
    const store = new ConfigStore(file2);
    const saved = store.set({
      ...store.get(),
      operations: { ...ops, zennRepoDir: '  ', projectName: '', keywords: [], zennTopics: [] },
    });
    expect(saved.operations?.zennRepoDir).toBeUndefined();
    expect(saved.operations?.projectName).toBeUndefined();
    expect(saved.operations?.keywords).toBeUndefined();
    expect(saved.operations?.zennTopics).toBeUndefined();
  });
});

describe('M42-1: updateCheckUrl(更新確認)の既定値と正規化', () => {
  const base: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
  };

  it('未設定なら既定=公式リリースAPI。空文字=無効は保持、不正形式は既定へ', async () => {
    expect(new ConfigStore(file).get().updateCheckUrl).toBe(DEFAULT_UPDATE_CHECK_URL);
    await writeFile(file, JSON.stringify({ ...base, updateCheckUrl: '' }), 'utf8');
    expect(new ConfigStore(file).get().updateCheckUrl).toBe('');
    await writeFile(file, JSON.stringify({ ...base, updateCheckUrl: 'ftp://bad' }), 'utf8');
    expect(new ConfigStore(file).get().updateCheckUrl).toBe(DEFAULT_UPDATE_CHECK_URL);
  });

  it('set() でも消えない(M41-5の事故を繰り返さない)', () => {
    const store = new ConfigStore(file);
    store.set({ ...base, updateCheckUrl: 'https://example.test/latest' });
    expect(new ConfigStore(file).get().updateCheckUrl).toBe('https://example.test/latest');
    store.set({ ...base, updateCheckUrl: '' });
    expect(new ConfigStore(file).get().updateCheckUrl).toBe('');
  });
});

describe('M43-1: operations.projectUrl(発信の {URL} 解決先)が保存で消えないこと', () => {
  const base: AppConfig = {
    autoApprove: { safe: true, write: false, exec: false },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
  };

  it('http(s) のURLは保持され、不正な値は落とす(投稿に変な文字列を混ぜない)', () => {
    const store = new ConfigStore(file);
    store.set({
      ...base,
      operations: { enabled: true, repos: [], zennSlugs: [], projectUrl: 'https://github.com/o/r' },
    });
    expect(new ConfigStore(file).get().operations?.projectUrl).toBe('https://github.com/o/r');

    store.set({ ...base, operations: { enabled: true, repos: [], zennSlugs: [], projectUrl: 'ふつうの文字列' } });
    expect(new ConfigStore(file).get().operations?.projectUrl).toBeUndefined();
  });
});
