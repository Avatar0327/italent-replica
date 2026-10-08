/**
 * 审计日志的显示元数据（docs/02_业务建模/20 §2：数据变更日志列「应用」「对象」「变更内容」）。
 * 字段中文名照搬原站任职记录字段（docs/02_业务建模/07 §3.1、15），未登记的字段按编码原样显示，不猜中文名。
 */

export interface AuditObjectMeta {
  readonly label: string;
  readonly app: string;
}

const ORG_PEOPLE = '组织员工';
const APPROVAL = '审批中心';
const ENTERPRISE = '企业设置';
const TALENT = '人才标准';
const IDP = '个人发展计划';

const OBJECTS: Readonly<Record<string, AuditObjectMeta>> = {
  'job-sequence-sync': { label: '任职序列同步任务', app: ORG_PEOPLE },
  'employment-record': { label: '任职记录', app: ORG_PEOPLE },
  'employment-business': { label: '任职业务', app: ORG_PEOPLE },
  employment_employee: { label: '员工信息', app: ORG_PEOPLE },
  employment_settings: { label: '任职设置', app: ORG_PEOPLE },
  employment_custom_field: { label: '任职自定义字段', app: ORG_PEOPLE },
  organization: { label: '组织单元', app: ORG_PEOPLE },
  'org-adjustment-run': { label: '组织调整任职联动', app: ORG_PEOPLE },
  org_setting: { label: '组织设置', app: ORG_PEOPLE },
  org_code_reservation: { label: '组织编码', app: ORG_PEOPLE },
  org_import_result: { label: '组织导入', app: ORG_PEOPLE },
  'transfer-request': { label: '调动申请', app: ORG_PEOPLE },
  transfer_settings: { label: '调动设置', app: ORG_PEOPLE },
  transfer_form: { label: '调动表单', app: ORG_PEOPLE },
  'establishment-scheme': { label: '编制方案', app: ORG_PEOPLE },
  'establishment-capacity': { label: '编制', app: ORG_PEOPLE },
  'TenantBase.EmploymentContract': { label: '合同协议', app: ORG_PEOPLE },
  'TenantBase.EmployeeInformation': { label: '员工信息', app: ORG_PEOPLE },
  'TenantBase.PersonalInformationChange': { label: '个人信息变更申请', app: ORG_PEOPLE },
  'approval-instance': { label: '审批单', app: APPROVAL },
  'approval-task': { label: '审批任务', app: APPROVAL },
  'approval-process': { label: '审批流程', app: APPROVAL },
  'approval-exception-admin': { label: '异常管理员', app: APPROVAL },
  tenant: { label: '租户', app: ENTERPRISE },
  tenant_setting: { label: '租户配置', app: ENTERPRISE },
  tenant_user: { label: '用户', app: ENTERPRISE },
  permission_admin: { label: '管理员', app: ENTERPRISE },
  permission_profile: { label: '身份', app: ENTERPRISE },
  permission_grant: { label: '用户授权', app: ENTERPRISE },
  permission_mou: { label: '管理单元', app: ENTERPRISE },
  license_pool: { label: '许可', app: ENTERPRISE },
  audit_retention: { label: '日志保留期', app: ENTERPRISE },
  'TalentCenter.DimensionLibrary': { label: '指标库', app: TALENT },
  'TalentCenter.Category': { label: '指标库分类', app: TALENT },
  'TalentCenter.DescriptionType': { label: '发展建议类型', app: TALENT },
  'TalentCenter.Dimension': { label: '指标', app: TALENT },
  'TalentCenter.TalentCriterionCategory': { label: '人才标准分类', app: TALENT },
  'TalentCenter.TalentCriterion': { label: '人才标准', app: TALENT },
  'TalentCenter.TalentCriterionModelImage': { label: '潜力模型图', app: TALENT },
  'IDP.IDPProcess': { label: '发展计划流程', app: IDP },
  'IDP.SubProcess': { label: '子流程', app: IDP },
  'IDP.IDPTemplate': { label: '发展计划模板', app: IDP },
  'IDP.IDPTemplateModule': { label: '发展计划模块', app: IDP },
  'IDP.IDPTemplateCommonGoal': { label: '模板通用目标', app: IDP },
  'IDP.Idp': { label: '发展计划', app: IDP },
  'IDP.IdpGoal': { label: '发展目标', app: IDP },
  'IDP.Task': { label: '目标任务', app: IDP },
  'IDP.GoalReview': { label: '目标回顾', app: IDP },
  'IDP.Analysis': { label: '综述', app: IDP },
  'IDP.Review': { label: '回顾', app: IDP },
  'IDP.TutorShip': { label: '带教信息', app: IDP },
  'IDP.Career': { label: '职业发展信息', app: IDP },
  'IDP.WorkShift': { label: '轮岗信息', app: IDP },
};

/** 对象编码前缀 → 应用（未单独登记的对象按所属模块归类）。 */
const APP_PREFIXES: readonly (readonly [string, string])[] = [
  ['approval', APPROVAL],
  ['permission', ENTERPRISE],
  ['tenant', ENTERPRISE],
  ['license', ENTERPRISE],
  ['audit', ENTERPRISE],
];

export function auditObjectMeta(objectType: string): AuditObjectMeta {
  const known = OBJECTS[objectType];
  if (known) return known;
  const app = APP_PREFIXES.find(([prefix]) => objectType.startsWith(prefix))?.[1] ?? ORG_PEOPLE;
  return { label: objectType, app };
}

/** 任职记录（及引用同名字段的组织、调动等对象）的字段中文名。 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  departmentId: '部门',
  positionId: '职位',
  postId: '职务',
  levelId: '职级',
  gradeId: '职等',
  place: '工作地点',
  directManagerId: '直线经理',
  dottedManagerId: '虚线经理',
  employmentType: '人员类别',
  employmentSource: '人员来源',
  employmentForm: '用工形式',
  identityLabel: '身份类型',
  sequenceId: '职务序列',
  professionalLineId: '专业条线',
  isKeyPerson: '是否关键人员',
  dimension1: '预置编制维度1',
  dimension2: '预置编制维度2',
  dimension3: '预置编制维度3',
  dimension4: '预置编制维度4',
  dimension5: '预置编制维度5',
  jobNumber: '工号',
  remarks: '备注',
  staffId: '任职ID',
  startDate: '开始日期',
  effectiveDate: '生效日期',
  lastWorkDate: '最后工作日',
  stopDate: '结束日期',
  entryDate: '入职日期',
  kind: '业务类型',
  mode: '发起方式',
  transferTypeCode: '调动类型',
  reasonCode: '调动原因',
  changeType: '变动类型',
  employeeStatus: '人员状态',
  entryStatus: '入职状态',
  isDepartmentHead: '是否部门负责人',
  isStoreManager: '是否店长',
  employType: '雇佣关系',
  state: '状态',
  status: '状态',
  name: '名称',
  shortName: '简称',
  code: '编码',
  establishedOn: '成立日期',
  personInChargeId: '负责人',
  hrbpId: 'HRBP',
  shopOwnerId: '店长',
  location: '地点',
  enabled: '启用',
  employeeId: '员工',
  value: '取值',
  // R3-T01 人才标准（`23` §2.1 字段名）
  libraryId: '指标库',
  definition: '定义',
  categoryId: '分类',
  ownerId: '所属人',
  ownerOrgId: '所属管理单元',
  grades: '等级描述',
  behaviors: '行为描述',
  suggestions: '发展建议',
  questions: '面试问题',
  abilityNote: '能力说明',
  potentialNote: '潜力说明',
  experienceNote: '经历说明',
  achievementNote: '成就说明',
  modelImage: '潜力模型图',
  filename: '文件名称',
  contentType: '文件格式',
  byteSize: '文件大小',
  sha256: '文件哈希',
};

export function auditFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** 引用字段：写入时把编号解析成当时的名称，日志冻结当时的显示值（原站变更内容记的是名称）。 */
export const AUDIT_REFERENCE_KINDS = [
  'org',
  'position',
  'post',
  'level',
  'grade',
  'sequence',
  'professionalLine',
  'employee',
] as const;
export type AuditReferenceKind = (typeof AUDIT_REFERENCE_KINDS)[number];

const REFERENCE_FIELDS: Readonly<Record<string, AuditReferenceKind>> = {
  departmentId: 'org',
  orgId: 'org',
  ownerOrgId: 'org',
  positionId: 'position',
  postId: 'post',
  levelId: 'level',
  gradeId: 'grade',
  sequenceId: 'sequence',
  professionalLineId: 'professionalLine',
  directManagerId: 'employee',
  dottedManagerId: 'employee',
  personInChargeId: 'employee',
  hrbpId: 'employee',
  shopOwnerId: 'employee',
  employeeId: 'employee',
};

export function auditReferenceKind(field: string): AuditReferenceKind | undefined {
  return REFERENCE_FIELDS[field];
}

/**
 * DEC-203（补充 DEC-197）：真正没有人员 / 组织归属的配置类对象，持有「日志审计」的查看人均可查看，不按“能否管理该配置”
 * 裁剪（字段权限照常裁剪，第四轮口径）。只有登记在这里的配置对象类型才按此放行；有独立业务权限规则的对象（编制方案、复制任务、组织导入回执、
 * 组织编码预占、审批实例、人员序码重算汇总等）不在此列，按业务规则判断（apps/api/src/audit/visibility.ts）；未登记的一律不可见（fail-closed）。
 */
export const AUDIT_CONFIG_OBJECT_TYPES: ReadonlySet<string> = new Set([
  'tenant',
  'tenant_setting',
  'tenant_user',
  'tenant_membership',
  'audit_retention',
  'employment-activation-run',
  'permission_admin',
  'permission_profile',
  'permission_grant',
  'permission_mou',
  'permission_identity_scope',
  'permission_user_app_scope',
  'permission_scope_policy',
  'permission_scope_app',
  'permission_dynamic_org_grant',
  'license_pool',
  'license_seat',
  'employment_settings',
  'employment_custom_field',
  'transfer_settings',
  'transfer_form',
  'personnel-order-settings',
  'org_setting',
  'job_setting',
  'establishment-settings',
  'approval-process',
  'approval-exception-admin',
]);

/**
 * 与业务对象共用对象类型、但实为配置的写入（按动作区分）：合同主数据（合同类型、法人公司、规则、设置）
 * 以合同对象类型写审计，没有所属人员，属于 DEC-203 的配置类日志。
 */
export const AUDIT_CONFIG_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'TenantBase.EmploymentContract': [
    'contract.types.save',
    'contract.companies.save',
    'contract.rule.save',
    'contract.settings.update',
  ],
};

/** 审计字段路径 → 字段权限编码：取末段；自定义字段两种写法（customFields.<id> 与 custom:<id>）都映射为 custom:<id>。 */
export function auditFieldCode(path: string): string {
  if (path.startsWith('customFields.')) return `custom:${path.slice('customFields.'.length)}`;
  return path.split('.').at(-1) ?? path;
}
