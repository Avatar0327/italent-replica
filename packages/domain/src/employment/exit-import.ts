/**
 * F-139a 历史离职人员导入：行字段的纯校验。
 * docs/08_设计/F-139_历史离职人员导入_设计.md §3（请求）、§4.1（区间与日期）、§5（加黑三项）。
 * 部门停用区间、编制、字典是否启用这类要读库的判断在 apps/api 的导入服务里做。
 */
import { isIsoDate } from '../audit/retention.js';
import { addDays } from '../contracts/rules.js';

/** 批量导入入口按钮：独立于五个离职按钮（DEC-814），标准角色默认不授予。 */
export const EXIT_IMPORT_BUTTON = 'Employment.DimissionImport';
/** 单批行数上限（设计 §3；与 MAX_LOOKUP_ROWS 同值）。 */
export const EXIT_IMPORT_ROW_LIMIT = 100;

export interface ExitImportIssue {
  readonly field?: string;
  readonly reason: string;
  readonly message: string;
}

/** 离职生效日 E = 最后工作日 L + 1（与离职单一致：最后工作日次日起不再在职）。 */
export function exitImportEffectiveDate(lastWorkDate: string): string {
  return addDays(lastWorkDate, 1);
}

const invalidDate = (field: string, label: string): ExitImportIssue => ({
  field,
  reason: 'VALIDATION_FAILED',
  message: `${label}不是有效日期（YYYY-MM-DD）`,
});

/**
 * 日期校验：H = 入职日、L = 最后工作日。H = L 合法（在职一天）；
 * L 必须早于今天（租户时区），L = 今天也拒绝——今天的离职走正常离职流程，历史导入不碰“当天生效”。
 */
export function validateExitImportDates(
  row: { entryDate: string; lastWorkDate: string },
  today: string,
): ExitImportIssue[] {
  const issues: ExitImportIssue[] = [];
  if (!isIsoDate(row.entryDate)) issues.push(invalidDate('entryDate', '入职日期'));
  if (!isIsoDate(row.lastWorkDate)) issues.push(invalidDate('lastWorkDate', '最后工作日'));
  if (issues.length > 0) return issues;
  if (row.entryDate > row.lastWorkDate) {
    return [
      {
        field: 'lastWorkDate',
        reason: 'EXIT_IMPORT_RANGE_INVERTED',
        message: '入职日期不能晚于最后工作日',
      },
    ];
  }
  if (row.lastWorkDate >= today) {
    return [
      {
        field: 'lastWorkDate',
        reason: 'EXIT_IMPORT_NOT_HISTORICAL',
        message: '最后工作日必须早于今天；今天及以后的离职请走离职流程',
      },
    ];
  }
  return [];
}

const normalizedNo = (employeeNo: string) => employeeNo.trim().toLowerCase();

/** 批内重复工号：每个重复工号的所有行都命中（不只后出现的），工号按去空白、不分大小写比较。 */
export function duplicateEmployeeNoRows(rows: readonly { rowNo: number; employeeNo: string }[]): Set<number> {
  const seen = new Map<string, number[]>();
  for (const row of rows) {
    const key = normalizedNo(row.employeeNo);
    seen.set(key, [...(seen.get(key) ?? []), row.rowNo]);
  }
  const duplicated = new Set<number>();
  for (const rowNos of seen.values()) if (rowNos.length > 1) rowNos.forEach((rowNo) => duplicated.add(rowNo));
  return duplicated;
}

/** 先红桩：真实实现在下一提交。 */
export function duplicateEmailRows(_rows: readonly { rowNo: number; email: string | null }[]): Set<number> {
  return new Set();
}

/** 加黑三项：只有勾选加黑才校验；原因必填，截止日（可空）不得早于离职生效日。 */
export function validateExitImportBlacklist(
  row: { addToBlacklist?: boolean; blacklistReason?: string; blacklistExpiryDate?: string },
  effectiveDate: string,
): ExitImportIssue[] {
  if (row.addToBlacklist !== true) return [];
  const issues: ExitImportIssue[] = [];
  if (!row.blacklistReason?.trim()) {
    issues.push({
      field: 'blacklistReason',
      reason: 'EXIT_BLACKLIST_REASON_REQUIRED',
      message: '加入黑名单时必须填写原因',
    });
  }
  const expiry = row.blacklistExpiryDate;
  if (expiry && (!isIsoDate(expiry) || expiry < effectiveDate)) {
    issues.push({
      field: 'blacklistExpiryDate',
      reason: isIsoDate(expiry) ? 'EXIT_BLACKLIST_EXPIRY_BEFORE_EFFECTIVE' : 'VALIDATION_FAILED',
      message: isIsoDate(expiry) ? '黑名单截止日期不能早于离职生效日' : '黑名单截止日期不是有效日期（YYYY-MM-DD）',
    });
  }
  return issues;
}
