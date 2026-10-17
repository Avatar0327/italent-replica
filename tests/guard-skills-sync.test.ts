/** F-189 / DEC-547：两种工具的仓库技能必须逐字节同步，新增技能也自动纳入守卫。 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLAUDE = join(ROOT, '.claude/skills');
const AGENTS = join(ROOT, '.agents/skills');

function listSkills(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => basename(path) === 'SKILL.md')
    .sort();
}

const claudeSkills = listSkills(CLAUDE);
const agentSkills = listSkills(AGENTS);
const allSkills = [...new Set([...claudeSkills, ...agentSkills])].sort();

describe('F-189 / DEC-547 仓库技能同步守卫', () => {
  it('两侧技能清单一致，并保留开发自检与交叉审查技能', () => {
    expect(agentSkills, '两侧必须同步增删技能').toEqual(claudeSkills);
    expect(agentSkills).toEqual(expect.arrayContaining(['dev-selfcheck/SKILL.md', 'cross-review/SKILL.md']));
  });

  for (const skill of allSkills) {
    it(`${skill} 在两侧存在且逐字节相同`, () => {
      const claudePath = join(CLAUDE, skill);
      const agentPath = join(AGENTS, skill);
      expect(existsSync(claudePath), `缺少 .claude/skills/${skill}`).toBe(true);
      expect(existsSync(agentPath), `缺少 .agents/skills/${skill}`).toBe(true);
      expect(readFileSync(agentPath).equals(readFileSync(claudePath)), `${skill} 内容不同，请同步修改两侧`).toBe(true);
    });
  }

  // F-193：YAML 里 " #" 之后会被当成注释截断（如“PR #xx”），故 description 必须整体加引号。
  for (const skill of allSkills) {
    it(`${skill} 的 description 整体加了引号且内部无未转义引号`, () => {
      for (const root of [CLAUDE, AGENTS]) {
        const text = readFileSync(join(root, skill), 'utf8');
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
        const line = front.split(/\r?\n/).find((entry) => entry.startsWith('description:'));
        expect(line, `${root}/${skill} 缺少 description`).toBeDefined();
        const value = (line ?? '').slice('description:'.length).trim();
        expect(value, `${root}/${skill} 的 description 未加双引号`).toMatch(/^"[^"\\]*"$/);
      }
    });
  }
});
