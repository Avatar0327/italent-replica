/**
 * 历史离职人员导入的纯规则：按钮、行数上限、生效日、同文件重复邮箱。
 * docs/08_设计/F-493_历史离职人员导入对齐北森_设计.md §3.3、§4.1。读库的判断（部门、字典、名称匹配）在 apps/api。
 */
import { addDays } from '../contracts/rules.js';

/** 批量导入入口按钮：独立于五个离职按钮（DEC-814），标准角色默认不授予。 */
export const EXIT_IMPORT_BUTTON = 'Employment.DimissionImport';
/** 单批行数上限（DEC-832，设计 §4.1）。 */
export const EXIT_IMPORT_ROW_LIMIT = 1000;

/** 离职生效日 E = 最后工作日 L + 1（与离职单一致：最后工作日次日起不再在职）。 */
export function exitImportEffectiveDate(lastWorkDate: string): string {
  return addDays(lastWorkDate, 1);
}

/**
 * 批内重复电子邮件（c 类，设计 §3.3）：每个重复邮箱的所有行都命中（不只后出现的），
 * 比较键 lower(btrim(email))；邮箱为空的行不参与。格式不对的行自己已有错误，由调用方先剔除。
 */
export function duplicateEmailRows(rows: readonly { rowNo: number; email: string | null }[]): Set<number> {
  const seen = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.email?.trim().toLowerCase() ?? '';
    if (key === '') continue;
    seen.set(key, [...(seen.get(key) ?? []), row.rowNo]);
  }
  const duplicated = new Set<number>();
  for (const rowNos of seen.values()) if (rowNos.length > 1) rowNos.forEach((rowNo) => duplicated.add(rowNo));
  return duplicated;
}
