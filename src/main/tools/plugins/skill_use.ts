import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M101: SKILL.md(オープン標準)互換 — スキル本文の読み込み。
 * skill_list で見つけた name の SKILL.md 全文を返す(progressive disclosure の展開側)。
 * name は英数字とハイフン/アンダースコアのみ許可(パストラバーサル対策。'..' や区切り文字は
 * 形式チェックで落ちる)。スキルフォルダに同梱ファイルがあれば一覧を末尾に付ける。
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** プラグインは相対importできないため、skill_list と重複してこのヘルパを持つ(契約上の制約) */
function skillDirs(ctx: ToolContext): string[] {
  const out: string[] = [];
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (typeof res === 'string' && existsSync(join(res, 'skills'))) out.push(join(res, 'skills'));
  const devDir = join(process.cwd(), 'resources', 'skills');
  if (existsSync(devDir)) out.push(devDir);
  if (ctx.userMemoryDir !== undefined && existsSync(join(ctx.userMemoryDir, 'skills'))) {
    out.push(join(ctx.userMemoryDir, 'skills'));
  }
  return out;
}

interface SkillUseInput {
  name: string;
}

function isSkillUseInput(value: unknown): value is SkillUseInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

export default {
  name: 'skill_use',
  description:
    'Load the full instructions of a skill (SKILL.md) by name. Call skill_list first to see what is available, then load only the skill relevant to the task and follow its instructions.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill folder name as shown by skill_list (e.g. "tdd-workflow")' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['スキル'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isSkillUseInput(input)) {
      return { content: 'Input must be an object with a string property "name".', isError: true };
    }
    const name = input.name.trim();
    if (!NAME_RE.test(name)) {
      // '..' や '/' '\\' を含む名前はここで落ちる(パストラバーサル対策)
      return { content: `Invalid skill name "${name}". Allowed: letters, digits, "-", "_" (max 64 chars).`, isError: true };
    }
    for (const dir of skillDirs(ctx)) {
      const mdPath = join(dir, name, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      const body = readFileSync(mdPath, 'utf8');
      // 同梱リソース(スクリプト・テンプレート等)は一覧だけ知らせる(必要時に read_file で開く)
      const extras = readdirSync(join(dir, name), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name !== 'SKILL.md')
        .map((e) => join(dir, name, e.name));
      const note = extras.length > 0 ? `\n\n[Bundled files]\n${extras.join('\n')}` : '';
      return { content: `${body}${note}` };
    }
    return { content: `Skill "${name}" not found. Run skill_list to see available skills.`, isError: true };
  },
} satisfies ToolPlugin;
