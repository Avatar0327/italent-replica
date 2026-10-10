/**
 * R3-T04 PR-B2 验收夹具（设计 §2.2）：评价规则 / 模块等级 / 字段映射。在 B1 的 configWorld / configOperator 之上，
 * 只补这三类对象的路径、最小合法载荷与字段快捷方法。
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { configWorld, TR_BASE, TR_NOW, type ConfigView } from './AC-TR-config-support.js';

export { configOperator, configWorld, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
export type { ConfigView } from './AC-TR-config-support.js';

export const SCORING_KINDS = {
  scoreRule: { path: '/score-rules', duplicate: 'SCORE_RULE_DUPLICATE', inUse: 'SCORE_RULE_IN_USE' },
  moduleGrade: { path: '/module-grades', duplicate: 'MODULE_GRADE_DUPLICATE', inUse: 'MODULE_GRADE_IN_USE' },
} as const;
export type ScoringKind = keyof typeof SCORING_KINDS;

let counter = 0;
export const uniq = () => {
  counter += 1;
  return `${counter}_${randomUUID().slice(0, 4)}`;
};
export const levels = (...names: string[]) => names.map((name, index) => ({ name, value: names.length - index }));
export const scoreRuleBody = (extra: Record<string, unknown> = {}) => ({
  name: `评价规则${uniq()}`,
  kind: 'numeric',
  minScore: 1,
  maxScore: 5,
  ...extra,
});
export const gradeRuleBody = (extra: Record<string, unknown> = {}) => ({
  name: `等级规则${uniq()}`,
  kind: 'grade',
  display: 'dropdown',
  levels: levels('高', '中', '低'),
  ...extra,
});
export const scoreItems = (...bounds: number[]) =>
  bounds.slice(0, -1).map((min, index) => ({
    name: `档${index + 1}`,
    value: String(index + 1),
    minScore: min,
    maxScore: bounds[index + 1]!,
  }));
export const moduleGradeBody = (extra: Record<string, unknown> = {}) => ({
  name: `模块等级${uniq()}`,
  items: scoreItems(0, 2, 4, 5),
  ...extra,
});
export const mappingBody = (sourceFieldId: string, targetFieldId: string, extra: Record<string, unknown> = {}) => ({
  scene: 'carry_last',
  sourceFieldId,
  targetFieldId,
  ...extra,
});

/** configWorld + 评分配置对象 / 字段 / 映射快捷方法。 */
export async function scoringWorld(db: Parameters<typeof configWorld>[0], label: string) {
  const w = await configWorld(db, label);
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await w.request('POST', path, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ConfigView;
  };
  const field = (extra: Record<string, unknown> = {}) => {
    const n = uniq();
    return post('/fields', { code: `map_${n}`, name: `映射字段${n}`, kind: 'text', group: 'evaluation', ...extra });
  };
  const optionField = (values: string[], kind = 'option') =>
    field({ kind, options: values.map((v) => ({ value: v, label: `选项${v}` })) });
  return { ...w, post, field, optionField, base: TR_BASE, now: TR_NOW };
}
