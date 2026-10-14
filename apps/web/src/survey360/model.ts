import { records } from '../evaluation/model.js';
import { m } from './messages.js';
export const validateQuestionnaireSelection = (ids: readonly string[]) =>
  ids.length >= 1 && ids.length <= 3 && new Set(ids).size === ids.length;
const pick = (row: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]]));
/** DTO 使用数据库 ID；整卷写入按稳定 key 引用，不能把缺失引用当空值清掉。 */
export function questionnaireContent(row: Record<string, unknown>) {
  if (!['roles', 'scales', 'dimensions', 'questions'].every((key) => Array.isArray(row[key])))
    throw new Error(m.incomplete);
  const scales = records(row.scales);
  const dimensions = records(row.dimensions);
  const keyOf = (id: unknown, items: Record<string, unknown>[]) => {
    if (id === null || id === undefined) return null;
    const key = items.find((item) => item.id === id)?.key;
    if (typeof key !== 'string') throw new Error(m.incomplete);
    return key;
  };
  return {
    roles: records(row.roles).map((r) => pick(r, ['key', 'roleId', 'weight'])),
    scales: scales.map((s) => ({
      ...pick(s, ['key', 'name']),
      options: records(s.options).map((o) => pick(o, ['key', 'label', 'value', 'notScored', 'remarkRequired'])),
    })),
    dimensions: dimensions.map((d) => ({
      ...pick(d, ['key', 'name', 'definition', 'weight', 'roleIds']),
      parentKey: keyOf(d.parentId, dimensions),
      scaleKey: keyOf(d.scaleId, scales),
    })),
    questions: records(row.questions).map((q) => ({
      ...pick(q, ['key', 'text', 'weight', 'allowRemark', 'roleIds']),
      dimensionKey: keyOf(q.dimensionId, dimensions),
      scaleKey: keyOf(q.scaleId, scales),
    })),
  };
}
