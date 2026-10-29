import { CONTRACT_FIELDS } from '../contracts/rules.js';
import { TRANSFER_LINKAGE_FIELDS } from '../approval/transfer-view.js';
import { OFFER_BUTTONS, OFFER_FIELDS, OFFER_STATUS_FIELDS } from '../offer/rules.js';
import { OFFER_APPROVAL_PROGRESS_FIELDS, OFFER_BATCH_FIELDS } from '../offer/approval.js';
import { ASSESSMENT_BUTTONS, ASSESSMENT_FIELDS, ASSESSMENT_SYSTEM_FIELDS } from '../employment/assessment.js';
import {
  EXIT_BUTTONS,
  EXIT_REQUEST_FIELDS,
  EXIT_REQUEST_SYSTEM_FIELDS,
  RETIREMENT_BUTTONS,
} from '../employment/exit.js';
import { RETIREMENT_REQUEST_FIELDS } from '../employment/retirement.js';
import {
  RETIREMENT_INTENTION_BUTTON,
  RETIREMENT_INTENTION_EDITABLE_FIELDS,
  RETIREMENT_INTENTION_SNAPSHOT_FIELDS,
} from '../employment/retirement-intention.js';
import { PART_TIME_BUTTONS, PART_TIME_FIELDS, PART_TIME_SYSTEM_FIELDS } from '../employment/part-time-constants.js';
/** Real schema/DTO catalogs for DEC-080. Functional rights never imply a data scope. */
import type { ButtonDefinition, DataOperation, ObjectDefinition } from './object-permission.js';

export const ORG_EMPLOYEE_APP = 'TenantBase';
const systemFields = [
  'id',
  'tenantId',
  'revision',
  'versionId',
  'versionNo',
  'previousVersionId',
  'createdAt',
  'updatedAt',
  'createdBy',
];
const button = (code: string, level: ButtonDefinition['level'], requires?: DataOperation): ButtonDefinition =>
  requires ? { code, level, requires } : { code, level };
const crud = [
  button('create', 'list', 'create'),
  button('update', 'detail', 'update'),
  button('delete', 'detail', 'delete'),
];
function object(code: string, fields: readonly string[], buttons = crud, system: readonly string[] = []) {
  const systems = new Set([...systemFields, ...system]);
  return {
    code: `TenantBase.${code}`,
    application: ORG_EMPLOYEE_APP,
    fields: [...new Set([...fields, ...systems])].map((code) => ({ code, system: systems.has(code) })),
    buttons,
  } satisfies ObjectDefinition;
}
const jobCommon = [
  'name',
  'code',
  'startDate',
  'stopDate',
  'effectiveDate',
  'enabled',
  'establishedOn',
  'displayOrder',
  'qualificationId',
  'sourceCode',
];
const ranges = ['levelTypeId', 'minLevelId', 'maxLevelId', 'minGradeId', 'maxGradeId'];
const assignment = [
  'sequenceId',
  'professionalLineId',
  ...ranges,
  'isKey',
  'isConfidential',
  'syncSequenceToAssignments',
];
const jobButtons = [...crud, button('import', 'list'), button('validate', 'detail')];
const job = (code: string, fields: readonly string[], system: readonly string[] = []) =>
  object(
    code,
    [...jobCommon, ...fields],
    ['JobPost', 'JobPosition'].includes(code) ? [...jobButtons, button('syncSequence', 'list', 'update')] : jobButtons,
    [...system, 'kind', 'objectId'],
  );

export const MODULE_OBJECTS = {
  contract: object(
    'EmploymentContract',
    [...CONTRACT_FIELDS, 'employeeId'],
    [
      ...crud,
      button('renew', 'detail', 'update'),
      button('change', 'detail', 'update'),
      button('terminate', 'detail', 'update'),
      button('import', 'list'),
      button('withdraw', 'detail', 'update'),
      button('createApplication', 'list', 'create'),
      button('renewApplication', 'detail', 'update'),
      button('changeApplication', 'detail', 'update'),
      button('terminateApplication', 'detail', 'update'),
    ],
    [
      'status',
      'approvalStatus',
      'signingCount',
      'previousContractId',
      'rootContractId',
      'versionNo',
      'operation',
      'mode',
      'targetId',
      'targetRevision',
      'resultId',
      'systemInitiated',
      'rowType',
    ],
  ),
  contractSettings: object('ContractSettings', [
    'autoRenew',
    'autoTerminate',
    'autoNumber',
    'accumulateRehire',
    'postExitTypeIds',
    'renewalTypeIds',
    'indefiniteTypeIds',
    'uniqueFields',
  ]),
  contractRules: object('ContractRenewalRule', ['name', 'priority', 'orgIds', 'personIds', 'enabled', 'details']),
  contractType: object('ContractType', ['code', 'name', 'enabled']),
  contractCompany: object('ContractCompany', ['code', 'name', 'enabled']),
  // R2 BE-14a（34 §2、OF-R1）：状态与转移 / 失效表单字段只经转移与失效命令写入，登记为系统字段（只可查看）
  offer: object(
    'Offer',
    ['entry', 'offerType', 'source', 'campusOfferId', ...OFFER_FIELDS],
    [
      ...crud,
      button(OFFER_BUTTONS.statusTransfer.code, OFFER_BUTTONS.statusTransfer.level, 'update'),
      button(OFFER_BUTTONS.lineStatusTransfer.code, OFFER_BUTTONS.lineStatusTransfer.level, 'update'),
    ],
    [
      'status',
      'approvalStatus',
      ...OFFER_STATUS_FIELDS,
      'sentBy',
      'sentAt',
      'copiedFromOfferId',
      'hasPendingEntry',
      'pendingEntryBusinessId',
      'syncStatus',
      'syncTarget',
      'syncReason',
      'syncMessage',
      'syncAttempts',
      'syncedAt',
      'lastSyncAt',
      'linkedEmployeeId',
      'syncedContractKind',
      ...OFFER_APPROVAL_PROGRESS_FIELDS,
    ],
  ),
  // F-222（codex-F185b B1/B2）：对象功能与功能权限仅两个详情页“不同意”按钮；通用工作流操作不在该取证结论内。
  // 不同意改变已有单据状态，沿用本文件审批提交 / 撤回 / 撤销的 update 数据操作；字段权限供审批中心披露。
  offerBatchApproval: object(
    'OfferBatchApproval',
    OFFER_BATCH_FIELDS,
    [button('PartDisAgree', 'detail', 'update'), button('AllDisAgree', 'detail', 'update')],
    ['status'],
  ),
  organization: object(
    'Organization',
    [
      'code',
      'name',
      'shortName',
      'broadType',
      'enabled',
      'startDate',
      'stopDate',
      'effectiveDate',
      'establishedOn',
      'personInChargeId',
      'hrbpId',
      'shopOwnerId',
      'costCenterId',
      'location',
      'remarks',
      'displayOrder',
      'isVirtual',
      'parents',
      'sourceCode',
      'parentId',
    ],
    [
      ...crud,
      button('reserve', 'list', 'create'),
      button('release', 'detail', 'delete'),
      button('validate', 'detail'),
      button('import', 'list'),
    ],
    ['fullName', 'level', 'resource', 'dimension', 'status', 'reason', 'orgId'],
  ),
  jobLayer: job('JobLayer', ['layerLevel']),
  jobGrade: job('JobGrade', ['grade', 'scoreLow', 'scoreHigh', 'layerId']),
  jobLevelType: job('JobLevelType', []),
  jobLevel: job('JobLevel', ['level', 'levelTypeId', 'minGradeId', 'maxGradeId']),
  jobSequence: job(
    'JobSequence',
    ['parentId', 'levelTypeId', 'source', 'externalId'],
    [
      'level',
      ...['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].map(
        (prefix) => `${prefix}SequenceId`,
      ),
    ],
  ),
  jobProfessionalLine: job('JobProfessionalLine', ['parentId'], ['level']),
  jobPost: job('JobPost', [...assignment, 'competencyModelId', 'responsibilities', 'requirements', 'evaluationScore']),
  jobPosition: job(
    'Position',
    [...assignment, 'orgId', 'postId', 'parents', 'workLocation', 'standardPositionId'],
    ['directParentId', 'dottedParentId', 'directSequence', 'dottedSequence'],
  ),
  establishment: object(
    'OrganizationEstablishment',
    [
      'name',
      'code',
      'periodType',
      'maintenanceMode',
      'startMonth',
      'subdivision',
      'unmatchedPolicy',
      'enabled',
      'startDate',
      'stopDate',
      'effectiveDate',
      'excludedOrgIds',
      'occupancyRanges',
      'orgId',
      'schemeId',
      'periodStart',
      'localCapacity',
      'inclusiveCapacity',
      'reservedLocal',
      'reservedInclusive',
      'strictControl',
      'syncParents',
      'subdivisions',
      'positionId',
      'adjustmentThrough',
      'capacityIds',
      'transferIn',
      'transferOut',
    ],
    [...crud, button('copy', 'list', 'create'), button('execute', 'detail', 'update'), button('report', 'detail')],
    [
      'capacityId',
      'status',
      'reason',
      'periodEnd',
      'scheme',
      'actualLocal',
      'actualInclusive',
      'pendingLocal',
      'pendingInclusive',
      'availableLocal',
      'availableInclusive',
      'isOverstaffed',
      'error',
      'sourceCapacityId',
      'targetCapacityId',
      'successCount',
      'failureCount',
      'items',
      'jobId',
      'attempts',
      'message',
      'recipientUserId',
      'readAt',
      'completedAt',
      'startedAt',
      'failureReason',
      'attempt',
    ],
  ),
  employmentSettings: object(
    'EmploymentSettings',
    [
      'allowDirectTransfer',
      'unrestrictTargetDepartment',
      'autoPopulate',
      // R2 BE-2b：入职生成邮箱规则（EN-R12）整份配置，一个字段承载规则列表
      'entryEmailRules',
      // F-321：用工形式生效 / 失效日期（类别、备注沿用已有字段）。
      'effectiveDate',
      'expiryDate',
      // R2-T03 离职三个字典（B60～62）挂在任职设置配置对象上：名称、编码、启用、显示顺序（设计 §2.1）
      'code',
      'name',
      'enabled',
      'displayOrder',
      // R2 BE-8a 离职自动加黑规则（B68）也挂在任职设置配置对象上：规则信息、加黑条件、加黑信息（name 已在上面）
      'priority',
      'orgIds',
      'description',
      'conditions',
      'term',
      'reason',
      'note',
      // R2 BE-15a 自动转正规则（B57）也挂在任职设置配置对象上：适用范围、业务处理规则、发起人类型、试用结果
      //（name / priority / orgIds / enabled 已在上面）；operatorUserId 是最后保存人，系统写入、只可查看
      'includeSubordinates',
      'mode',
      'daysBefore',
      'initiatorType',
      'probationResult',
      // R2 BE-15b2 自动发起试用期考核规则（B58）也挂在这里：考核类型、入职后天数（考核名称 = name，其余沿用上面的）
      'assessmentType',
      'daysAfterEntry',
      // R2 BE-8b1 离职交接事项（B64，DEC-266③）也挂在这里：事项类别、序号、待办类别、待办事项、办理表单、备注（没有适用人群与负责人）
      'category',
      'sequenceNo',
      'todoType',
      'title',
      'formRef',
      'remark',
    ],
    crud,
    ['operatorUserId'],
  ),
  // R2 BE-15b1（B2，29 PB-R3）：试用中考核 / 转正考核。发起 = Assessment.Create，审批通过后改意见 = Assessment.Edit（都是详情级）；
  // 审批流转（自评 / 评价）走审批中心，不在这里授按钮。状态、发起方式、发起人、生成的转正记录由系统写入，只可查看
  probationAssessment: object(
    'ProbationAssessment',
    ASSESSMENT_FIELDS,
    [button(ASSESSMENT_BUTTONS.create, 'detail', 'create'), button(ASSESSMENT_BUTTONS.update, 'detail', 'update')],
    ASSESSMENT_SYSTEM_FIELDS,
  ),
  employmentCustomField: object('EmploymentCustomField', ['name', 'objectType', 'valueType', 'inherit'], crud, [
    'code',
  ]),
  // R2 BE-8a 黑名单（B68，差距表“补证结论 R2f”）：无组织字段，数据范围只认看全部；加黑日期 / 来源 / 状态由系统写入。
  // 行内“移出”与工具栏“移出”共用 remove@list（原站是否两个独立权限项未验证）；导入未验证，不登记按钮（后补）。
  blacklist: object(
    'Blacklist',
    ['employeeId', 'name', 'idNumber', 'mobilePhone', 'email', 'reason', 'expiryDate', 'note'],
    [
      button('create', 'list', 'create'),
      button('update', 'list_row', 'update'),
      button('remove', 'list', 'update'),
      button('delete', 'list', 'delete'),
    ],
    ['blacklistDate', 'source', 'status', 'removedAt'],
  ),
  // BE-12a 人事分析 - 时点员工花名册（规格 35 §2.2）：功能权只有“查看”和列表级“导出”按钮；数据范围与字段权复用
  // 员工档案（EmployeeInformation）、任职记录、合同三个对象，所以这个对象本身没有业务字段，asOf 只是请求参数
  hrRoster: object('HrRoster', ['asOf'], [button('export', 'list')]),
  // F-022：人员状态 / 入职状态取当前生效主职版本，只读（系统字段：可授查看，不可授编辑）
  employee: object(
    'Employee',
    ['code', 'name'],
    [button('Employee.Create', 'list', 'create')],
    ['status', 'employeeStatus', 'entryStatus'],
  ),
  employmentRecord: object(
    'EmploymentRecord',
    [
      'kind',
      'mode',
      'initiator',
      'withEstablishment',
      'transferTypeCode',
      'reasonCode',
      'effectiveDate',
      'lastWorkDate',
      'formId',
      'staffId',
      'departmentId',
      'positionId',
      'postId',
      'levelId',
      'gradeId',
      'place',
      'directManagerId',
      'dottedManagerId',
      'employmentType',
      'employmentSource',
      'employmentForm',
      'sequenceId',
      'professionalLineId',
      'isKeyPerson',
      'dimension1',
      'dimension2',
      'dimension3',
      'dimension4',
      'dimension5',
      'jobNumber',
      'remarks',
      'isDepartmentHead',
      'isStoreManager',
      'addedSubordinateIds',
      'transferTypeCode',
      'reasonCode',
      'employType',
      // R1-T10 调动联动（`13` §7 表单区块）：审批披露、盲审与字段权限共用这些编码。
      ...TRANSFER_LINKAGE_FIELDS,
      // R2-T03 离职扩展字段（设计 §4A / §9，lastWorkDate / reasonCode 已在上面）
      ...EXIT_REQUEST_FIELDS,
      // BE-7 兼职（设计 §7.2）：兼职类型、结束日期、申请备注
      ...PART_TIME_FIELDS,
      // R2-T04 5d2 意向退休申请（设计 §11.1）：意向日期、申请原因登记为本对象的业务字段（申请表是独立表，不新建权限对象）
      ...RETIREMENT_INTENTION_EDITABLE_FIELDS,
    ],
    [
      button('Employment.Create', 'detail', 'create'),
      button('Transfer.Hr', 'detail', 'create'),
      button('Transfer.Manager', 'detail', 'create'),
      button('Transfer.Self', 'detail', 'create'),
      button('EmploymentRecord.LineOp.Transfer', 'list_row', 'create'),
      button('Employment.Tranfer', 'list', 'create'),
      button('Employment.Edit', 'detail', 'update'),
      button('Employment.Delete', 'detail', 'delete'),
      button('Employment.Submit', 'detail', 'update'),
      button('Employment.Withdraw', 'detail', 'update'),
      // R1-T11：调动管理视图「撤销」未审批完成的申请（`08` §6，AC-TRF-07）
      button('Employment.Revoke', 'detail', 'update'),
      button('Employment.Import', 'list'),
      button('Employment.Preview', 'detail'),
      // R1-T08：生效失败 / 挂起的申请修正后重试（DEC-052）
      button('Employment.RetryActivation', 'detail', 'update'),
      // R2-T03 离职（设计 §4A）：直接离职 / 离职申请 / 编辑离职 / 撤销离职
      button(EXIT_BUTTONS.direct, 'detail', 'create'),
      button(EXIT_BUTTONS.application, 'detail', 'create'),
      button(EXIT_BUTTONS.edit, 'detail', 'update'),
      button(EXIT_BUTTONS.cancel, 'detail', 'update'),
      // R2-T04 退休（设计 §12.2，DEC-637 A-2）：独立于 Dimission*；RetireCancel 的路由在 5a′
      button(RETIREMENT_BUTTONS.direct, 'detail', 'create'),
      button(RETIREMENT_BUTTONS.application, 'detail', 'create'),
      button(RETIREMENT_BUTTONS.edit, 'detail', 'update'),
      button(RETIREMENT_BUTTONS.cancel, 'detail', 'update'),
      // R2-T04 5d2：HR 代员工提出意向退休日期申请（自助入口随 F-020）
      button(RETIREMENT_INTENTION_BUTTON, 'detail', 'create'),
      // BE-7 兼职（设计 §7.2）：新增兼职 / 新增兼职申请 / 延长申请 / 结束申请 / 批量结束 / 编辑兼职
      button(PART_TIME_BUTTONS.direct, 'detail', 'create'),
      button(PART_TIME_BUTTONS.application, 'detail', 'create'),
      button(PART_TIME_BUTTONS.extend, 'detail', 'update'),
      button(PART_TIME_BUTTONS.end, 'detail', 'update'),
      button(PART_TIME_BUTTONS.batchEnd, 'list', 'update'),
      button(PART_TIME_BUTTONS.edit, 'detail', 'update'),
    ],
    [
      'employeeId',
      'employeeRevision',
      'status',
      'entryDate',
      'serviceType',
      'stopDate',
      'previousRecordId',
      'isCurrent',
      'isLatest',
      'isInserted',
      // 变动类型由系统联动写入（F-006，W-416），不是可编辑字段。
      'changeType',
      // 待入职列表带出的 Offer 同步值（BE-14b2）：合同公司、试用期月数，只读
      'contractCompanyId',
      'probationMonths',
      // 人员状态 / 入职状态只经业务流转写入（F-022，15 §9.3）：可授查看，不可授编辑。
      'employeeStatus',
      'entryStatus',
      'activation',
      ...EXIT_REQUEST_SYSTEM_FIELDS,
      // R2-T04 退休扩展字段：类型由 L 与快照 P 派生，P 快照与是否返聘不可手改
      ...RETIREMENT_REQUEST_FIELDS,
      // 意向申请的快照三项（申请时冻结的预计退休日期与弹性上下限）只读
      ...RETIREMENT_INTENTION_SNAPSHOT_FIELDS,
      // 兼职：原定结束日期取申请版本，任职状态 / 视图归属按期限链派生，只可授查看
      ...PART_TIME_SYSTEM_FIELDS,
    ],
  ),
} as const satisfies Record<string, ObjectDefinition>;

export type ModuleAction =
  | { readonly kind: 'object'; readonly objectCode: string; readonly operation: 'view' | DataOperation }
  | { readonly kind: 'admin'; readonly capability: string };
const tenantConfiguration: ModuleAction = { kind: 'admin', capability: 'other_settings' };
const actions: Record<string, ModuleAction> = {
  'tenant.settings.read': tenantConfiguration,
  'tenant.settings.write': tenantConfiguration,
  'tenant.employment.configuration.write': tenantConfiguration,
};
for (const [name, definition] of Object.entries({
  org: MODULE_OBJECTS.organization,
  job: MODULE_OBJECTS.jobPost,
  establishment: MODULE_OBJECTS.establishment,
  employment: MODULE_OBJECTS.employmentRecord,
})) {
  for (const [verb, operation] of Object.entries({
    read: 'view',
    write: 'update',
    create: 'create',
    update: 'update',
    delete: 'delete',
  } as const)) {
    actions[`tenant.${name}.${verb}`] = { kind: 'object', objectCode: definition.code, operation };
  }
}
export const MODULE_ACTIONS: Readonly<Record<string, ModuleAction>> = actions;
