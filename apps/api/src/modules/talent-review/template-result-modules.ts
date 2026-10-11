/** DEC-425①：引用表持有模块 ID，名称文本只在版本内冻结；换版本必须经过身份映射，不能按同名接管。 */
import { checkRenameRoundTrip, fieldNodes, parseStoredFormula } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ResultRuleView } from './template-results.js';

export interface ResultModule {
  id: string;
  name: string;
  kind: string;
  previousModuleId?: string | null;
}
const invalid = (reason: string) => new AppError('VALIDATION_FAILED', '结果公式引用的模块已删除或不再适用', { reason });
const references = (formula: string) => {
  const parsed = parseStoredFormula(formula);
  if (!parsed.ok) throw invalid('FORMULA_INVALID');
  return fieldNodes(parsed.program).filter((node) => node.fieldId === undefined && node.path[0] === '模块');
};
const nameOf = (path: readonly string[]) => path.slice(1, -1).join('.');

export function bindResultModules(formula: string, modules: readonly ResultModule[]): string[] {
  return [
    ...new Set(
      references(formula).map((node) => {
        const module = modules.find((m) => m.kind === 'indicator' && m.name === nameOf(node.path));
        if (!module) throw invalid('FORMULA_INVALID');
        return module.id;
      }),
    ),
  ];
}

export function carryResultModules(
  row: ResultRuleView,
  previous: readonly ResultModule[],
  modules: readonly ResultModule[],
  fields: readonly { id: string; name: string }[],
): ResultRuleView {
  const bindings = row.refModuleIds.map((id) => {
    const before = previous.find((m) => m.id === id);
    const after = modules.find((m) => m.previousModuleId === id && m.kind === 'indicator');
    if (!before || !after) throw invalid('RESULT_MODULE_DELETED');
    return { before, after };
  });
  let formula = '';
  let cursor = 0;
  // 基于 AST 源码区间替换，不改字符串或碰巧包含旧名称的其他字段。
  for (const node of references(row.formula)) {
    const pair = bindings.find(({ before }) => before.name === nameOf(node.path));
    if (!pair) throw invalid('RESULT_MODULE_DELETED');
    formula += row.formula.slice(cursor, node.pos.offset) + `模块.${pair.after.name}.${node.path.at(-1)}`;
    cursor = node.end;
  }
  formula += row.formula.slice(cursor);
  const known = (path: string) =>
    modules.some((m) => m.kind === 'indicator' && (path === `模块.${m.name}.得分` || path === `模块.${m.name}.等级`));
  if (formula !== row.formula && !checkRenameRoundTrip(formula, fields, known).ok) {
    throw invalid('RESULT_MODULE_FORMULA_INVALID');
  }
  return { ...row, formula, refModuleIds: bindings.map(({ after }) => after.id) };
}
