/**
 * 员工时点花名册的列、字段权来源与取值规则（docs/02_业务建模/35 §2.2；BE-12a）。
 * 列顺序照原站（总编排补充 4）；每列声明它受哪个对象的哪个字段权约束，列表与导出共用这一份，保证“不导出比列表更多的列”。
 */
import { EMPLOYEE_STATUS_LABELS, type EmployeeStatusCode } from '../employment/employee-status.js';
import { decimalYears } from '../personnel/tenure.js';

/** 字段权来源：人员对象（员工档案）/ 任职记录对象 / 合同对象。后两者另须对象查看权。 */
export type RosterSource = 'person' | 'record' | 'contract';
export interface RosterColumn {
  readonly key: string;
  readonly label: string;
  /** 全部满足才可见（如直线经理邮箱 = 任职记录的直线经理字段 + 人员的工作邮箱字段）。 */
  readonly gate: readonly (readonly [RosterSource, string])[];
}

const person = (key: string, label: string, field = key): RosterColumn => ({ key, label, gate: [['person', field]] });
const record = (key: string, label: string, field = key): RosterColumn => ({ key, label, gate: [['record', field]] });
const contract = (key: string, label: string, field = key): RosterColumn => ({
  key,
  label,
  gate: [['contract', field]],
});

/** 固定列“人员”：姓名 + 工号。 */
export const ROSTER_FIXED_COLUMNS: readonly RosterColumn[] = [
  person('employeeName', '姓名', 'name'),
  person('code', '工号'),
];

export const ROSTER_COLUMNS: readonly RosterColumn[] = [
  record('level', '职级', 'levelId'),
  person('gender', '性别'),
  person('birthday', '出生日期'),
  person('age', '年龄'),
  person('educationLevel', '最高学历'),
  person('lastSchool', '毕业学校名称'),
  person('graduateDate', '毕业时间'),
  person('major', '专业'),
  person('mobilePhone', '手机'),
  person('idNumber', '证件号码'),
  // 规格 17：个人邮箱 = BackupMail（Email 是登录 / 主邮箱，不在名册里）
  person('backupMail', '个人邮箱'),
  person('registAddress', '籍贯'),
  person('householdAddress', '户籍所在地'),
  person('householdCategory', '户口类别'),
  person('nation', '民族'),
  person('marryCategory', '婚姻状况'),
  person('politicalStatus', '政治面貌'),
  // 仓库没有入党 / 团日期字段（不新增档案字段）：恒为空，权限随政治面貌
  person('partyJoinDate', '入党/团日期', 'politicalStatus'),
  person('workDate', '参加工作日期'),
  person('emergencyContact', '紧急联系人'),
  person('emergencyRelationship', '与本人关系'),
  person('emergencyPhone', '紧急联系人电话'),
  person('entryDate', '入职日期'),
  record('startDate', '开始日期', 'effectiveDate'),
  record('endDate', '结束日期', 'effectiveDate'),
  record('directManagerName', '直线经理', 'directManagerId'),
  {
    key: 'directManagerEmail',
    label: '直线经理邮箱',
    gate: [
      ['record', 'directManagerId'],
      ['person', 'workEmail'],
    ],
  },
  record('employmentType', '人员类别'),
  person('companyTenureYears', '累计司龄（年）', 'entryDate'),
  person('workTenureYears', '累计工龄（年）', 'workDate'),
  record('place', '工作地点'),
  record('employmentForm', '用工形式'),
  person('employeeStatus', '人员状态'),
  record('hasProbation', '是否有试用期', 'employeeStatus'),
  record('probationStartDate', '试用开始日期', 'employeeStatus'),
  record('probationExpectedEndDate', '预计试用结束日期', 'employeeStatus'),
  record('probationMonths', '试用期(月)', 'employeeStatus'),
  record('regularizationDate', '转正日期', 'employeeStatus'),
  person('lastWorkDate', '最后工作日'),
  record('orgFullName', '组织全称', 'departmentId'),
  record('orgLevel1', '一级组织', 'departmentId'),
  record('orgLevel2', '二级组织', 'departmentId'),
  record('orgLevel3', '三级组织', 'departmentId'),
  contract('contractType', '合同类型', 'typeId'),
  contract('contractTermType', '合同期限类型', 'termType'),
  contract('contractEffectiveDate', '合同生效日期', 'effectiveDate'),
  contract('contractEndDate', '合同终止日期', 'endDate'),
  contract('contractTermMonths', '合同期限（月）', 'termMonths'),
  contract('contractActualTerminationDate', '实际终止时间', 'actualTerminationDate'),
];

export const ROSTER_EMPLOYEE_STATUSES: readonly EmployeeStatusCode[] = [2, 3];
export const ROSTER_EMPLOY_TYPES = ['internal', 'intern'] as const;
/** 同步导出的行数上限（沿用现有导出常量 10000，超出提示缩小范围）。 */
export const ROSTER_EXPORT_MAX_ROWS = 10_000;

/** 合同期限类型的显示名（花名册列与合同情况看板“按期限类型”同用）。 */
export const TERM_TYPE_LABELS: Readonly<Record<string, string>> = {
  fixed: '固定期限',
  indefinite: '无固定期限',
  task: '以完成一定工作任务为期限',
};

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * 累计司龄 / 工龄（15 §字段规格 WorkYearCompanyTotal / WorkYearTotal）：(asOf − 起算日) / 365，按 1 位小数向下舍位；
 * 起算日为空或晚于 asOf 为空。校正值字段仓库里没有，按 0。
 */
export function tenureYears(from: string | null, asOf: string): string | null {
  return from && from <= asOf ? decimalYears(day(asOf) - day(from), 1) : null;
}

/** 导出单元格文本：状态 / 期限类型 / 布尔转中文，空为空串；其余按原值。 */
export function rosterCellText(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (key === 'employeeStatus') return EMPLOYEE_STATUS_LABELS[value as EmployeeStatusCode] ?? String(value);
  if (key === 'contractTermType') return TERM_TYPE_LABELS[String(value)] ?? String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
