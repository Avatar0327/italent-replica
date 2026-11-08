/**
 * 全部人员列表的列、字段权来源（F-474-4c，DEC-776 / DEC-836；原站“组织员工 → 人员信息 → 全部人员”，规格 codex-R1bd §2.3）。
 * 列顺序照原站；每列声明受哪个对象的哪个字段权约束（与时点花名册同一套 RosterColumn，取值也是同一份读取），
 * 人员侧字段按员工档案对象、任职侧字段按任职记录对象，无权的整列缺席。
 */
import type { EmployeeStatusCode } from '../employment/employee-status.js';
import type { RosterColumn } from './roster.js';

const person = (key: string, label: string, field = key): RosterColumn => ({ key, label, gate: [['person', field]] });
const record = (key: string, label: string, field = key): RosterColumn => ({ key, label, gate: [['record', field]] });

export const ALL_PEOPLE_COLUMNS: readonly RosterColumn[] = [
  person('employeeName', '姓名', 'name'),
  person('email', '邮箱'),
  person('code', '工号'),
  record('orgLevel1', '一级组织', 'departmentId'),
  record('orgLevel2', '二级组织', 'departmentId'),
  record('orgLevel3', '三级组织', 'departmentId'),
  record('departmentName', '部门', 'departmentId'),
  record('level', '职级', 'levelId'),
  record('positionName', '职位', 'positionId'),
  record('directManagerName', '直线经理', 'directManagerId'),
  person('entryDate', '入职日期'),
  {
    key: 'companyTenureYears',
    label: '司龄',
    gate: [
      ['person', 'entryDate'],
      ['record', 'workYearCompanyBefore'],
    ],
  },
  person('gender', '性别'),
  person('idType', '证件类型'),
  person('idNumber', '证件号码'),
  person('age', '年龄'),
];

/** 人员状态筛选的缺省值：试用 + 正式（原站默认选中，规格 §2.3）。 */
export const ALL_PEOPLE_DEFAULT_STATUSES: readonly EmployeeStatusCode[] = [2, 3];
/** 本列表只含主职时间轴上的记录；兼职 / 借调 / 外派不在本列表。 */
export const ALL_PEOPLE_SERVICE_TYPES = ['primary'] as const;
/** 雇佣关系枚举（任职记录 employType 字段，与 employment/fields.ts 同一份取值）。 */
export const ALL_PEOPLE_EMPLOY_TYPES = ['internal', 'intern', 'external'] as const;
