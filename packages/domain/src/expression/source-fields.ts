/**
 * 数据源记录对象的固定字段（#89-4）：取数函数在记录作用域里读的字段名由数据源决定，不在调用方的盘点字段目录里。
 * 其中带连字符的字段名（360结果.问卷-他评总分 等）靠这里认作一个字段名，不传字段目录也不会被拆成减法。
 * 只登记字段名固定的数据源；考核结果、测验结果、人才评定、人事子集的字段名没有带连字符的已知字段，不登记（按减法）。
 */
import { SURVEY360_FIELDS } from '../survey360/rules.js';

export const SURVEY360_OBJECT = '360结果';

const SOURCE_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [SURVEY360_OBJECT, new Set<string>(Object.values(SURVEY360_FIELDS))],
]);

/** `对象.字段` 是数据源的固定字段。 */
export function isDataSourceField(path: string): boolean {
  const dot = path.indexOf('.');
  if (dot < 0) return false;
  return SOURCE_FIELDS.get(path.slice(0, dot))?.has(path.slice(dot + 1)) === true;
}
