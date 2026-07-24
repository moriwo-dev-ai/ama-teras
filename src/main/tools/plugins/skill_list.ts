import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M101: SKILL.md(オープン標準)互換 — スキル一覧。
 * スキル = <dir>/<name>/SKILL.md のフォルダ。frontmatter の name/description だけを返し、
 * 本文は skill_use で取る(progressive disclosure: 使う瞬間まで本文をコンテキストに載せない)。
 * 置き場は 同梱(resources/skills) と ユーザー(userData/skills)。同名は同梱が勝つ
 * (プラグインローダの「組み込みが勝つ」と同じ規律)。
 */

/** プラグインは相対importできないため、skill_use と重複してこのヘルパを持つ(契約上の制約) */
function skillDirs(ctx: ToolContext): { dir: string; origin: 'bundled' | 'user' }[] {
  const out: { dir: string; origin: 'bundled' | 'user' }[] = [];
  // 配布版: extraResources の resources/skills。開発版: リポジトリ直下の resources/skills
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (typeof res === 'string' && existsSync(join(res, 'skills'))) {
    out.push({ dir: join(res, 'skills'), origin: 'bundled' });
  }
  const devDir = join(process.cwd(), 'resources', 'skills');
  if (existsSync(devDir)) out.push({ dir: devDir, origin: 'bundled' });
  if (ctx.userMemoryDir !== undefined && existsSync(join(ctx.userMemoryDir, 'skills'))) {
    out.push({ dir: join(ctx.userMemoryDir, 'skills'), origin: 'user' });
  }
  return out;
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const block = m?.[1];
  if (block === undefined) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      out[kv[1] as 'name' | 'description'] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

export default {
  name: 'skill_list',
  description:
    'List available skills (SKILL.md open standard). Returns name + one-line description for each; load the full instructions with skill_use only when a skill is relevant to the current task.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: 'safe',
  tags: ['スキル'],
  async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const seen = new Map<string, { description: string; origin: string }>();
    for (const { dir, origin } of skillDirs(ctx)) {
      const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const e of entries) {
        if (seen.has(e.name)) continue; // 先勝ち = 同梱が勝つ(同梱ディレクトリを先に積む)
        const mdPath = join(dir, e.name, 'SKILL.md');
        if (!existsSync(mdPath)) continue;
        const fm = parseFrontmatter(readFileSync(mdPath, 'utf8'));
        seen.set(e.name, { description: fm.description ?? '(no description)', origin });
      }
    }
    if (seen.size === 0) {
      return { content: 'No skills installed. (bundled: resources/skills, user: userData/skills/<name>/SKILL.md)' };
    }
    const lines = [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => `- ${name}${v.origin === 'user' ? ' (user)' : ''}: ${v.description}`);
    return { content: `${seen.size} skill(s). Use skill_use {"name": "..."} to load one.\n${lines.join('\n')}` };
  },
} satisfies ToolPlugin;
