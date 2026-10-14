/**
 * 本地演示租户的合成数据（F-025）：名称一律带“演示”字样或为岗位称谓，邮箱一律 example.com，
 * 不含真实人名、真实邮箱、北森租户数据或任何凭据（AGENTS.md §5）。
 */

export const DEMO_TENANT = { code: 'demo-r1', name: '演示科技有限公司', timezone: 'Asia/Shanghai' } as const;

/** 组织、职务体系的生效起点与人员入职日（都早于演示当天，保证经理身份与审批人解析可见）。 */
export const DEMO_DATES = { established: '2018-01-01', hired: '2024-01-01' } as const;

export type OrgKey = string;

export interface DemoOrgDef {
  readonly key: OrgKey;
  /** 确定的组织编码（幂等判定的自然键）。 */
  readonly code: string;
  readonly name: string;
  readonly parent: OrgKey | null;
}

/**
 * 行政维度组织树：租户根（集团）→ 3 个事业部 → 9 个部门 → 20 个小组，共 32 个，编码 DEMO-ORG-001…032。
 * 顺序即创建顺序（上级先于下级）；原有 6 个组织（rd / platform / frontend / data / hr / finance）名称与演示身份挂靠不变。
 */
const ORG_ROWS: readonly (readonly [OrgKey, string, OrgKey | null])[] = [
  ['rd', '研发中心', null],
  ['platform', '平台研发部', 'rd'],
  ['frontend', '前端开发组', 'platform'],
  ['backend', '后端开发组', 'platform'],
  ['infra', '基础架构组', 'platform'],
  ['data', '数据研发部', 'rd'],
  ['dataplat', '数据平台组', 'data'],
  ['algo', '算法组', 'data'],
  ['product', '产品设计部', 'rd'],
  ['pm', '产品组', 'product'],
  ['design', '设计组', 'product'],
  ['ops', '运营中心', null],
  ['marketing', '市场部', 'ops'],
  ['brand', '品牌组', 'marketing'],
  ['growth', '增长组', 'marketing'],
  ['sales', '销售部', 'ops'],
  ['east', '华东销售组', 'sales'],
  ['north', '华北销售组', 'sales'],
  ['south', '华南销售组', 'sales'],
  ['cs', '客户成功部', 'ops'],
  ['impl', '实施交付组', 'cs'],
  ['support', '客户服务组', 'cs'],
  ['corp', '职能中心', null],
  ['hr', '人力资源部', 'corp'],
  ['recruit', '招聘培训组', 'hr'],
  ['comp', '薪酬绩效组', 'hr'],
  ['finance', '财务部', 'corp'],
  ['acct', '会计核算组', 'finance'],
  ['budget', '资金预算组', 'finance'],
  ['admin', '行政法务部', 'corp'],
  ['office', '行政组', 'admin'],
  ['legal', '法务组', 'admin'],
];
export const DEMO_ORGS: readonly DemoOrgDef[] = ORG_ROWS.map(([key, name, parent], index) => ({
  key,
  name,
  parent,
  code: `DEMO-ORG-${String(index + 1).padStart(3, '0')}`,
}));

export type SequenceKey = 'tech' | 'support' | 'product' | 'ops' | 'sales' | 'mgmt';
export const DEMO_SEQUENCES: readonly { key: SequenceKey; name: string; code: string }[] = [
  { key: 'tech', name: '技术序列', code: 'DEMO_SEQ_TECH' },
  { key: 'support', name: '职能序列', code: 'DEMO_SEQ_SUPPORT' },
  { key: 'product', name: '产品序列', code: 'DEMO_SEQ_PRODUCT' },
  { key: 'ops', name: '运营序列', code: 'DEMO_SEQ_OPS' },
  { key: 'sales', name: '销售序列', code: 'DEMO_SEQ_SALES' },
  { key: 'mgmt', name: '管理序列', code: 'DEMO_SEQ_MGMT' },
];

export type PostKey = string;
export interface DemoPostDef {
  readonly key: PostKey;
  readonly name: string;
  readonly code: string;
  readonly sequence: SequenceKey;
  /** 职级类别：P 专业类、M 管理类（职务允许的职级区间 P1–P6 / M1–M3）。 */
  readonly track: 'P' | 'M';
}
const post = (key: PostKey, name: string, sequence: SequenceKey, track: 'P' | 'M' = 'P'): DemoPostDef => ({
  key,
  name,
  sequence,
  track,
  code: `DEMO_POST_${key.toUpperCase()}`,
});
/** 22 个职务；前 4 个沿用原有编码，演示身份引用它们。 */
export const DEMO_POSTS: readonly DemoPostDef[] = [
  { ...post('engineer', '软件工程师', 'tech'), code: 'DEMO_POST_ENG' },
  { ...post('rdManager', '研发经理', 'tech', 'M'), code: 'DEMO_POST_RDM' },
  { ...post('hrSpecialist', '人力资源专员', 'support'), code: 'DEMO_POST_HR' },
  { ...post('accountant', '会计', 'support'), code: 'DEMO_POST_ACC' },
  post('testEngineer', '测试工程师', 'tech'),
  post('architect', '架构师', 'tech'),
  post('dataEngineer', '数据工程师', 'tech'),
  post('algoEngineer', '算法工程师', 'tech'),
  post('productManager', '产品经理', 'product'),
  post('designer', '交互设计师', 'product'),
  post('marketer', '市场专员', 'ops'),
  post('csManager', '客户成功经理', 'ops'),
  post('implConsultant', '实施顾问', 'ops'),
  post('salesRep', '销售代表', 'sales'),
  post('salesManager', '销售经理', 'sales'),
  post('recruiter', '招聘专员', 'support'),
  post('finAnalyst', '财务分析师', 'support'),
  post('adminClerk', '行政专员', 'support'),
  post('legalClerk', '法务专员', 'support'),
  post('buHead', '事业部总经理', 'mgmt', 'M'),
  post('deptHead', '部门经理', 'mgmt', 'M'),
  post('groupLead', '小组长', 'mgmt', 'M'),
];

/** 职位 = 部门 × 职务。这 7 个是演示身份引用的原有职位；其余职位由 scale-data.ts 按各组织的编制表派生。 */
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

/**
 * 部门负责人与 HRBP：平台 / 数据研发部的负责人是演示经理；其余组织的负责人取自生成员工（scale-data.ts）。
 * HR 专员兼任全部组织的 HRBP，调动第二个审批节点落到他。
 */
export const DEMO_PERSONA_HEADS: Readonly<Record<OrgKey, string>> = {
  platform: 'platformManager',
  data: 'dataManager',
};
export const DEMO_HRBP_KEY = 'hr';

export const DEMO_TRANSFER_PROCESS_CODE = 'DEMO_TRANSFER';
