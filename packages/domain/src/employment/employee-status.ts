/**
 * 人员状态 / 入职状态（F-022；docs/02_业务建模/15 §9，Q-M0-96～99）。
 * 两者随任职版本存储，表示该版本的目标状态；员工“当前”状态取当前生效主职版本上的值。
 * 编码照原站枚举（TenantBase.EmployeeStatus / TenantBase.EntryStatus），展示用中文标签。
 */
export const EMPLOYEE_STATUS = {
  pendingEntry: 1,
  probation: 2,
  regular: 3,
  transferredOut: 4,
  pendingTransferIn: 5,
  retired: 6,
  left: 8,
  informal: 12,
} as const;
export type EmployeeStatusCode = (typeof EMPLOYEE_STATUS)[keyof typeof EMPLOYEE_STATUS];
export const EMPLOYEE_STATUS_CODES: readonly EmployeeStatusCode[] = Object.values(EMPLOYEE_STATUS);

export const EMPLOYEE_STATUS_LABELS: Readonly<Record<EmployeeStatusCode, string>> = {
  1: '待入职',
  2: '试用',
  3: '正式',
  4: '调出',
  5: '待调入',
  6: '退休',
  8: '离职',
  12: '非正式',
};

/**
 * 终止任职业务（离职 → 离职 8；退休 → 退休 6，R2-T04 §4）的唯一判定：评审组退组、继任结束等“人退出”下游的订阅入口、
 * 到期判断与后台复核都调用它，不在各订阅方各写一个 kind / 状态分支（DEC-431①）。
 */
export const TERMINATING_RECORD_STATUS = { leave: EMPLOYEE_STATUS.left, retirement: EMPLOYEE_STATUS.retired } as const;
export const TERMINATING_EMPLOYEE_STATUSES: readonly EmployeeStatusCode[] = Object.values(TERMINATING_RECORD_STATUS);
export const isTerminatingRecord = (kind: string, employeeStatus: number): boolean =>
  Object.hasOwn(TERMINATING_RECORD_STATUS, kind) &&
  TERMINATING_RECORD_STATUS[kind as keyof typeof TERMINATING_RECORD_STATUS] === employeeStatus;
/** 员工状态口径（employees.ts：left / retired）是否已终止任职。 */
export const isTerminatedEmployeeStatus = (status: string): boolean => status === 'left' || status === 'retired';
/** 终止业务的中文名（审计 / 结束原因文案）。 */
export const TERMINATING_KIND_LABELS = { leave: '离职', retirement: '退休' } as const;

/** 入职状态可为空（未填写）；待入职视图把空也当作有效待入职（Q-M0-76）。 */
export const ENTRY_STATUS = { normal: 0, cancelled: 1, postponed: 2 } as const;
export type EntryStatusCode = (typeof ENTRY_STATUS)[keyof typeof ENTRY_STATUS];
export const ENTRY_STATUS_CODES: readonly EntryStatusCode[] = Object.values(ENTRY_STATUS);

export const ENTRY_STATUS_LABELS: Readonly<Record<EntryStatusCode, string>> = { 0: '正常', 1: '取消', 2: '延期' };

/** 两个字段只能经业务流转写入（15 §9.3），任职编辑、导入、批量编辑一律拒绝。 */
export const EMPLOYMENT_STATUS_FIELDS = ['employeeStatus', 'entryStatus'] as const;

export function isEmployeeStatusCode(value: unknown): value is EmployeeStatusCode {
  return EMPLOYEE_STATUS_CODES.includes(value as EmployeeStatusCode);
}

export function isEntryStatusCode(value: unknown): value is EntryStatusCode {
  return ENTRY_STATUS_CODES.includes(value as EntryStatusCode);
}
