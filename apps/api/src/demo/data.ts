/**
 * 本地演示租户的合成数据（F-025）：名称一律带“演示”字样或为岗位称谓，邮箱一律 example.com，
 * 不含真实人名、真实邮箱、北森租户数据或任何凭据（AGENTS.md §5）。
 */

export const DEMO_TENANT = { code: 'demo-r1', name: '演示科技有限公司', timezone: 'Asia/Shanghai' } as const;

/** 组织、职务体系的生效起点与人员入职日（都早于演示当天，保证经理身份与审批人解析可见）。 */
export const DEMO_DATES = { established: '2023-01-01', hired: '2024-01-01' } as const;

export type OrgKey = 'rd' | 'platform' | 'frontend' | 'data' | 'hr' | 'finance';

/** 行政维度多层组织树：一级 → 二级 → 三级。父级 null 表示挂在租户根下。 */
export const DEMO_ORGS: readonly { key: OrgKey; name: string; parent: OrgKey | null }[] = [
  { key: 'rd', name: '研发中心', parent: null },
  { key: 'platform', name: '平台研发部', parent: 'rd' },
  { key: 'frontend', name: '前端开发组', parent: 'platform' },
  { key: 'data', name: '数据研发部', parent: 'rd' },
  { key: 'hr', name: '人力资源部', parent: null },
  { key: 'finance', name: '财务部', parent: null },
];

export type SequenceKey = 'tech' | 'support';
export const DEMO_SEQUENCES: readonly { key: SequenceKey; name: string; code: string }[] = [
  { key: 'tech', name: '技术序列', code: 'DEMO_SEQ_TECH' },
  { key: 'support', name: '职能序列', code: 'DEMO_SEQ_SUPPORT' },
];

export type PostKey = 'engineer' | 'rdManager' | 'hrSpecialist' | 'accountant';
export const DEMO_POSTS: readonly { key: PostKey; name: string; code: string; sequence: SequenceKey }[] = [
  { key: 'engineer', name: '软件工程师', code: 'DEMO_POST_ENG', sequence: 'tech' },
  { key: 'rdManager', name: '研发经理', code: 'DEMO_POST_RDM', sequence: 'tech' },
  { key: 'hrSpecialist', name: '人力资源专员', code: 'DEMO_POST_HR', sequence: 'support' },
  { key: 'accountant', name: '会计', code: 'DEMO_POST_ACC', sequence: 'support' },
];

/** 职位 = 部门 × 职务。 */
export const DEMO_POSITIONS: readonly { key: string; name: string; org: OrgKey; post: PostKey }[] = [
  { key: 'platformManager', name: '平台研发部经理', org: 'platform', post: 'rdManager' },
  { key: 'platformEngineer', name: '平台研发工程师', org: 'platform', post: 'engineer' },
  { key: 'frontendEngineer', name: '前端开发工程师', org: 'frontend', post: 'engineer' },
  { key: 'dataManager', name: '数据研发部经理', org: 'data', post: 'rdManager' },
  { key: 'dataEngineer', name: '数据研发工程师', org: 'data', post: 'engineer' },
  { key: 'hrSpecialist', name: '人力资源专员', org: 'hr', post: 'hrSpecialist' },
  { key: 'accountant', name: '会计', org: 'finance', post: 'accountant' },
];

export type PersonaRole = 'system_admin' | 'hr' | 'manager' | 'employee' | 'audit_admin' | 'exception_admin';

export const ROLE_LABELS: Readonly<Record<PersonaRole, string>> = {
  system_admin: '系统管理员',
  hr: 'HR（HRBP）',
  manager: '部门负责人（经理）',
  employee: '普通员工',
  audit_admin: '审计管理员',
  exception_admin: '异常管理员',
};

/** 各角色在演示前端的推荐入口。 */
export const ROLE_ENTRIES: Readonly<Record<PersonaRole, { path: string; label: string }>> = {
  system_admin: { path: '/', label: '调动管理' },
  hr: { path: '/', label: '调动管理' },
  manager: { path: '/manager', label: '管理者工作台' },
  employee: { path: '/self', label: '员工自助' },
  audit_admin: { path: '/', label: '（审计日志接口 /api/tenant/audit）' },
  exception_admin: { path: '/', label: '（审批异常处理）' },
};

export interface DemoPersonDef {
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly role: PersonaRole;
  /** 有人员档案的才入职；系统管理员、异常管理员是开通时登记的外部用户（DEC-158）。 */
  readonly job?: { org: OrgKey; post: PostKey; position?: string; managerKey?: string };
}

/**
 * 顺序即入职顺序：经理先于其下属入职，下属才能引用直线经理。
 * 普通员工只任职务、不占职位：本人调动入口不能编辑职位，带着原部门职位调到别的部门会被“职位必须属于任职部门”拒绝
 * （原站本人调动的职位处理交取证核对，见 PR #92），演示主线因此让普通员工不占职位。
 */
export const DEMO_PEOPLE: readonly DemoPersonDef[] = [
  { key: 'admin', name: '系统管理员（演示）', email: 'demo.admin@example.com', role: 'system_admin' },
  { key: 'exception', name: '异常管理员（演示）', email: 'demo.exception@example.com', role: 'exception_admin' },
  {
    key: 'hr',
    name: 'HR专员（演示）',
    email: 'demo.hr@example.com',
    role: 'hr',
    job: { org: 'hr', post: 'hrSpecialist', position: 'hrSpecialist' },
  },
  {
    key: 'platformManager',
    name: '平台研发部经理（演示）',
    email: 'demo.manager.platform@example.com',
    role: 'manager',
    job: { org: 'platform', post: 'rdManager', position: 'platformManager' },
  },
  {
    key: 'dataManager',
    name: '数据研发部经理（演示）',
    email: 'demo.manager.data@example.com',
    role: 'manager',
    job: { org: 'data', post: 'rdManager', position: 'dataManager' },
  },
  {
    key: 'employeeA',
    name: '平台研发员工甲（演示）',
    email: 'demo.employee.a@example.com',
    role: 'employee',
    job: { org: 'platform', post: 'engineer', managerKey: 'platformManager' },
  },
  {
    key: 'employeeB',
    name: '平台研发员工乙（演示）',
    email: 'demo.employee.b@example.com',
    role: 'employee',
    job: { org: 'platform', post: 'engineer', managerKey: 'platformManager' },
  },
  {
    key: 'employeeC',
    name: '数据研发员工丙（演示）',
    email: 'demo.employee.c@example.com',
    role: 'employee',
    job: { org: 'data', post: 'engineer', managerKey: 'dataManager' },
  },
  {
    key: 'auditor',
    name: '审计管理员（演示）',
    email: 'demo.auditor@example.com',
    role: 'audit_admin',
    job: { org: 'finance', post: 'accountant', position: 'accountant' },
  },
];

/** 部门负责人（经理）与 HRBP：HR 专员兼任各业务部门 HRBP，调动第二个审批节点落到他。 */
export const DEMO_ORG_ROLES: readonly { org: OrgKey; head?: string; hrbp?: string }[] = [
  { org: 'platform', head: 'platformManager', hrbp: 'hr' },
  { org: 'frontend', hrbp: 'hr' },
  { org: 'data', head: 'dataManager', hrbp: 'hr' },
  { org: 'rd', hrbp: 'hr' },
];

export const DEMO_TRANSFER_PROCESS_CODE = 'DEMO_TRANSFER';
