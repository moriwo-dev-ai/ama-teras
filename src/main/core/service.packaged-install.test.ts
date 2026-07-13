import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig, EvolutionEvent } from '../../shared/types';
import type { ToolPlugin } from '../tools/types';
import { EventBus } from './events';
import { AgentService } from './service';

/**
 * M71: 配布版(app.isPackaged)でツールを導入できるかを固定する。
 *
 * 実機の配布版で確認したこと: `evolution:enqueue` は必ず
 * 「配布版ではコア自己進化は動作しません」で失敗し、プラグイン導入は**その enqueue の上に
 * 建っていた**ため、ファイルからもレジストリからも一切入らなかった。
 * さらに置き場すら無かった(同梱先は Program Files 配下の resources/plugins)。
 */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

const CODE = `
import type { ToolPlugin } from '../types';
export default {
  name: 'line_count',
  description: '行数を数える',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() {
    return { content: 'ok' };
  },
} satisfies ToolPlugin;
`;

const MANIFEST = {
  name: 'line_count',
  version: '1.0.0',
  pluginApiVersion: '^1',
  description: '行数を数える',
  author: 'tester',
  license: 'AGPL-3.0-or-later',
  permissions: { network: false, childProcess: false, fsScope: 'none' },
  dependencies: [],
};

let base: string;
let src: string;
let userDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'm71-svc-'));
  src = join(base, 'src');
  userDir = join(base, 'plugins');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'line_count.ts'), CODE, 'utf8');
  await writeFile(join(src, 'manifest.json'), JSON.stringify(MANIFEST), 'utf8');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 配布版と同じ構成: 進化は必ず throw、導入先は userData/plugins */
function makePackagedService(installed: Map<string, ToolPlugin>): { svc: AgentService; bus: EventBus; events: EvolutionEvent[] } {
  const bus = new EventBus();
  const events: EvolutionEvent[] = [];
  bus.subscribe('evolution:event', (e) => events.push(e));
  const svc = new AgentService({
    bus,
    registry: {
      list: () => [...installed.values()],
      get: (n) => installed.get(n),
      // 実機の loader と同じ振る舞い: 置かれていれば読める
      reload: async () => {
        installed.clear();
        if (existsSync(join(userDir, 'line_count.ts'))) {
          installed.set('line_count', { name: 'line_count' } as ToolPlugin);
        }
      },
      errors: [],
    },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => base,
    denyPaths: { userDataDir: join(base, 'ud'), repoGitDir: join(base, 'git') },
    createEvolution: () => ({
      list: () => [],
      enqueue: () => {
        throw new Error('配布版ではコア自己進化は動作しません');
      },
    }),
    packaged: true,
    userPluginsDir: userDir,
  });
  return { svc, bus, events };
}

describe('M71: 配布版でもツールを導入できる(進化パイプラインを通さない)', () => {
  it('承認すれば導入され、すぐ使える(進化ジョブは1件も起票されない)', async () => {
    const installed = new Map<string, ToolPlugin>();
    const { svc, events } = makePackagedService(installed);

    const started = svc.pluginImportStart(src, 'レジストリ');
    // 承認ダイアログ(昇格と同じ経路)にコード全文と取得元が出る
    await new Promise((r) => setTimeout(r, 10));
    const req = events.find((e) => e.kind === 'promotion_request');
    if (req?.kind !== 'promotion_request') throw new Error('承認要求が飛んでいない');
    expect(req.toolName).toBe('line_count');
    expect(req.diff).toContain('レジストリ');
    expect(req.diff).toContain("name: 'line_count'");

    svc.evolutionPromoteRespond(req.jobId, true);
    const result = await started;

    expect(result.ok).toBe(true);
    expect(existsSync(join(userDir, 'line_count.ts'))).toBe(true);
    expect(installed.has('line_count')).toBe(true); // リロード済み=すぐ使える
  });

  it('承認しなければ何も置かない', async () => {
    const installed = new Map<string, ToolPlugin>();
    const { svc, events } = makePackagedService(installed);

    const started = svc.pluginImportStart(src, 'ローカルファイル');
    await new Promise((r) => setTimeout(r, 10));
    const req = events.find((e) => e.kind === 'promotion_request');
    if (req?.kind !== 'promotion_request') throw new Error('承認要求が飛んでいない');
    svc.evolutionPromoteRespond(req.jobId, false);
    const result = await started;

    expect(result.ok).toBe(false);
    expect(result.message).toContain('承認されなかった');
    expect(existsSync(join(userDir, 'line_count.ts'))).toBe(false);
  });
});
