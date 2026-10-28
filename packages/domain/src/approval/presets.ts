import { CONTRACT_FIELDS } from '../contracts/rules.js';
/**
 * 出厂预置流程（DEC-018 / DEC-094 / DEC-116）：全部审批类型都有草稿预置，租户开通时配置异常管理员后发布（R1-T17）；
 * 例外：组织调整预置取人口径是推断（DEC-644 A-2），只装草稿、不随开通发布（publishOnProvision）。
 * 有标准流程编码的类型都带“流程编码 = 标准编码”发起条件（`14` §11.1）。调动按本租户已取证的节点结构（`14` §2、§8.2、
 * §8.3，开关按 §11.10 更正）与 TransferDetailView 已交付字段（§11.2，DEC-118）预置；离职按 §8.5 取证的
 * “直接上级 → HR 访谈”结构，直接上级取最新生效主职任职的直线经理（DEC-230）；
 * 其余类型的节点结构尚未取证（TODO(需取证 #38)），预置为
 * “部门负责人审批 → HRBP 审核”，由租户调整后发布。
 */
import { ASSESSMENT_FORM_FIELDS } from '../employment/assessment.js';
import { EXIT_FORM_FIELDS } from '../employment/exit.js';
import { RETIREMENT_REQUEST_FIELDS } from '../employment/retirement.js';
import { RETIREMENT_INTENTION_FORM_FIELDS } from '../employment/retirement-intention.js';
import { TRANSFER_FORM_FIELDS } from './transfer-view.js';
import {
  APPROVAL_TYPES,
  type ApprovalTypeCode,
  type ApproverExpression,
  type ProcessDefinition,
  type SingleApprovalNode,
} from './types.js';

export interface PresetProcess {
  readonly presetKey: string;
  readonly code: string;
  readonly approvalType: ApprovalTypeCode;
  readonly definition: ProcessDefinition;
  /** 租户开通时是否随异常管理员一并发布；缺省发布。false = 只装草稿，由租户确认节点审批人后自行发布。 */
  readonly publishOnProvision?: false;
}

/**
 * 预置节点的回避开关一律显式写值，不依赖新建节点的缺省值（DEC-329④ 起缺省关闭，F-048 设计 §3.2）。按 DEC-332①：
 * 非 IDP 预置（调动、入职、离职、转正、实习转正、退休、组织调整、新增员工、四类合同、个人信息变更、员工子集变更）都会
 * 产生重大影响或涉及敏感信息，发起人与异动本人不能审批自己的单据，avoidSelf = true；IDP 预置不敏感、影响不大，
 * avoidSelf = false（IDP_ACTIONS，DEC-318 K-37）。逐个预置的理由见设计 §3.3；以后新增预置（如调薪）按“是否敏感 /
 * 是否有重大影响”逐个定值并补进该表。单主体业务的预置 avoidSubjects = false；集合审批的盘点结果审批为 true（D-34）。
 */
const PRESET_RECUSAL = { avoidSelf: true, avoidSubjects: false } as const;
const PRESET_ACTIONS = {
  transfer: false,
  addSign: false,
  copySend: false,
  retrieve: false,
  reject: true,
  urge: 'inherit',
  ...PRESET_RECUSAL,
} as const;

/**
 * 相同 / 历史相同审批人自动处理默认关闭：本租户调动流程各节点都未启用（`14` §11.10 更正 §8.3，登记册 C-008），
 * 功能仍可由管理员按节点开启。节点动作在预置缺省（PRESET_ACTIONS）上覆盖，回避开关不会因覆盖动作而丢失。
 */
const node = (key: string, name: string, approver: ApproverExpression, extra: Partial<SingleApprovalNode> = {}) =>
  ({
    key,
    name,
    approver,
    noAssignee: 'exception_admin',
    sameAssigneeSkip: false,
    historySameAssigneeSkip: false,
    sameAssigneeResult: 'approve',
    historySameAssigneeResult: 'approve',
    formFields: TRANSFER_FORM_FIELDS,
    editableFields: [],
    editMode: 'none',
    rejectCommentRequired: false,
    hideRecords: false,
    rejectResubmit: 'restart',
    messageRules: [],
    avoidSubjectsResult: 'skip',
    ...extra,
    actions: { ...PRESET_ACTIONS, ...extra.actions },
  }) satisfies SingleApprovalNode;

/**
 * IDP 预置节点的开关（DEC-318，原站 MakePlan 节点原值）：回避、加签、转交、抄送、撤回全部关闭（K-37 / K-39）；
 * 员工节点只有同意与跳转，指导人节点另有驳回与驳回到上一步（K-39）。
 */
const IDP_ACTIONS = {
  transfer: false,
  addSign: false,
  copySend: false,
  retrieve: false,
  urge: 'inherit',
  avoidSelf: false,
  avoidSubjects: false,
  revoke: false,
  jump: true,
} as const;
const IDP_EMPLOYEE_ACTIONS = { ...IDP_ACTIONS, reject: false } as const;
const IDP_TUTOR_ACTIONS = { ...IDP_ACTIONS, reject: true, rejectToPrevious: true } as const;

type DraftInput = Omit<
  ProcessDefinition,
  'exceptionAdminUserId' | 'urgeEnabled' | 'groupName' | 'hideRecordsFromInitiator'
>;
const draft = (definition: DraftInput): ProcessDefinition => ({
  groupName: '员工审批流程',
  exceptionAdminUserId: null,
  urgeEnabled: true,
  hideRecordsFromInitiator: false,
  ...definition,
});

/** “流程编码 = 本类型标准编码”发起条件；没有标准编码的类型预置为本类型兜底流程（DEC-018）。 */
function standardCondition(type: ApprovalTypeCode): Pick<ProcessDefinition, 'conditions' | 'isFallback'> {
  const code = APPROVAL_TYPES[type].defaultProcessCode;
  if (!code) return { isFallback: true, conditions: { items: [], expression: '' } };
  return {
    isFallback: false,
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: code }], expression: '1' },
  };
}

/** 未取证节点结构的任职类审批：部门负责人审批 → HRBP 审核（TODO(需取证 #38)）。 */
const GENERIC_FORM = ['effectiveDate', 'departmentId', 'postId', 'positionId', 'levelId'];
type GenericType = Exclude<
  ApprovalTypeCode,
  | 'transfer'
  | 'leave'
  | 'personnel_change'
  | 'emp_info_change'
  | 'part_time_add'
  | 'part_time_extend'
  | 'part_time_end'
  | 'offer'
  | 'offer_batch'
  | 'org_adjustment'
  | 'retirement_intention'
>;
function genericPreset(type: GenericType): PresetProcess {
  const name = APPROVAL_TYPES[type].name;
  const form = type.startsWith('contract_') ? CONTRACT_FIELDS : GENERIC_FORM;
  return {
    presetKey: `standard_${type}`,
    code: `Standard_${type}`,
    approvalType: type,
    definition: draft({
      name: `标准${name}流程`,
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition(type),
      nodes: [
        node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: form }),
        node('hrbp', 'HRBP审核', 'record_department_hrbp', { formFields: form }),
      ],
    }),
  };
}

// R2-T03 §9：离职表单带出离职类型 / 原因 / 去向等扩展字段，审批人按字段权限看到（盲审照常）
const LEAVE_FORM = ['lastWorkDate', 'effectiveDate', 'departmentId', 'postId', ...EXIT_FORM_FIELDS];
// R2-T04 §3.4：退休表单带出退休类型 / 是否同时返聘 / 预计退休日期（只读），审批人只看本单字段（DEC-057）
const RETIRE_FORM = ['lastWorkDate', 'effectiveDate', 'departmentId', 'postId', ...RETIREMENT_REQUEST_FIELDS];

/**
 * 兼职三类申请（R2-T05 §4.5）：节点名照原站角色。新增 / 延长按 R2d 取证的“主职部门 HRBP → 主职部门负责人 → 兼职部门 HRBP
 * → 兼职部门负责人”，结束按 R2f1 / F-165③ 相反。HRBP 无人时转异常管理员（F-165③），首节点无人提交即报错（DEC-054）。
 * 三类节点都“同意时打开可编辑的业务表单”（结束 R2f1；新增 / 延长 F234A C9，DEC-629）：结束 / 延长可改结束日期与申请备注
 * （延长的新结束日期必填，A-14 / B-8）；新增可改兼职类型 / 结束日期 / 兼职部门 / 直线经理 / 职务 / 职级，必填兼职类型 / 开始日期 /
 * 兼职部门由业务校验把关。薪资、工号、开始日期不开；“是否部门负责人”随 PT-7 开放（DEC-634）；新增下属只读展示、不开编辑（F234A C9 字段集，取最小集合；F-280）。
 * 开始日期的字段权限编码未定（§7.2 只登记 6 个新字段），表单暂不放。
 */
const PART_TIME_FORM = [
  'partTimeType',
  'departmentId',
  'postId',
  'levelId',
  'directManagerId',
  'isDepartmentHead',
  'addedSubordinateIds',
  'endDate',
  'requestRemark',
];
/** 审批中可编辑的表单字段（F-249）：延长 / 结束只改结束日与备注；新增见上方注释。 */
const PART_TIME_EDITABLE = {
  part_time_add: [
    'partTimeType',
    'endDate',
    'departmentId',
    'directManagerId',
    'postId',
    'levelId',
    'isDepartmentHead',
  ],
  part_time_extend: ['endDate', 'requestRemark'],
  part_time_end: ['endDate', 'requestRemark'],
} as const;
const PART_TIME_NODES = {
  primaryHrbp: ['primary_hrbp', '主职部门HRBP', 'latest_record_department_hrbp'],
  primaryHead: ['primary_head', '主职部门负责人', 'latest_record_department_head'],
  partTimeHrbp: ['part_time_hrbp', '兼职部门HRBP', 'record_department_hrbp'],
  partTimeHead: ['part_time_head', '兼职部门负责人', 'record_department_head'],
} as const satisfies Record<string, readonly [string, string, ApproverExpression]>;
const HRBP_FIRST = ['primaryHrbp', 'primaryHead', 'partTimeHrbp', 'partTimeHead'] as const;
const HEAD_FIRST = ['partTimeHead', 'partTimeHrbp', 'primaryHead', 'primaryHrbp'] as const;

function partTimePreset(
  type: 'part_time_add' | 'part_time_extend' | 'part_time_end',
  code: string,
  order: readonly (keyof typeof PART_TIME_NODES)[],
): PresetProcess {
  const name = APPROVAL_TYPES[type].name;
  const edit: Partial<SingleApprovalNode> = {
    editMode: 'with_approve',
    editableFields: [...PART_TIME_EDITABLE[type]],
  };
  return {
    presetKey: `standard_${type}`,
    code,
    approvalType: type,
    definition: draft({
      name: `标准${name}流程`,
      description: '出厂预置：按原站兼职流程节点结构建立，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition(type),
      nodes: order.map((key) => {
        const [nodeKey, nodeName, approver] = PART_TIME_NODES[key];
        return node(nodeKey, nodeName, approver, { formFields: PART_TIME_FORM, ...edit });
      }),
    }),
  };
}

/** 不同意连到结束（DEC-144）：上级不同意即结束，不再到下一节点（OF-R15）。 */
const AGREE_OR_NOT = ['approve', 'disagree'] as const;

/**
 * Offer 两类审批（BE-14a3，DEC-094 草稿）。候选人与 Offer 薪资属敏感信息，avoidSelf = true（DEC-332①）；候选人不是员工、
 * 没有主体集合，avoidSubjects = false。表单按类型统一（OF-R12）：单个 Offer 用 Offer 字段集，批量用批量单三项。
 * - 单个 Offer 审批：节点未取证（OF-R15 末句），沿用占位，只放“录用部门负责人”一个节点，由租户调整后发布；
 * - Offer 批量审批：照原站 OfferBatchApprovalProcess——直接上级（申请人的直接上级；空 = 无操作，首节点为空提交报错，
 *   DEC-054）→ 审批主体一级组织负责人（空 = 转异常管理员）；不得照搬“录用部门负责人”。
 */
const OFFER_PRESETS: readonly PresetProcess[] = [
  {
    presetKey: 'standard_offer',
    code: 'StandardOfferApproval',
    approvalType: 'offer',
    definition: draft({
      name: '标准Offer审批流程',
      description: '出厂预置：节点结构未取证（录用部门负责人占位），发布前须配置异常管理员',
      priority: 0,
      ...standardCondition('offer'),
      nodes: [
        node('offer_department_head', '录用部门负责人', 'offer_department_head', {
          formFields: APPROVAL_TYPES.offer.formFields,
          exits: AGREE_OR_NOT,
        }),
      ],
    }),
  },
  {
    presetKey: 'standard_offer_batch',
    code: 'StandardOfferBatchApproval',
    approvalType: 'offer_batch',
    definition: draft({
      name: '标准Offer批量审批流程',
      description: '出厂预置：直接上级 → 审批主体一级组织负责人，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition('offer_batch'),
      nodes: [
        node('direct_manager', '直接上级', 'initiator_direct_manager', {
          formFields: APPROVAL_TYPES.offer_batch.formFields,
          noAssignee: 'none',
          exits: AGREE_OR_NOT,
        }),
        node('first_level_head', '审批主体一级组织负责人', 'approval_subject_first_level_org_head', {
          formFields: APPROVAL_TYPES.offer_batch.formFields,
          exits: AGREE_OR_NOT,
        }),
      ],
    }),
  },
];

/**
 * 组织调整审批（R2-T08 §4.2，DEC-526②）：HRBPLeader 审批 → HR 负责人审批两个节点，表单即类型 formFields 全部编码。
 * 两节点取人“审批主体组织的 HRBP / 负责人”是推断，非原站事实（DEC-644 A-2）：复刻组织只有负责人、HRBP 两个角色字段，
 * 不把它们自动等同原站的两个审批角色。因此预置只是可改草稿，不随租户开通发布（publishOnProvision: false），
 * 租户自行确认节点审批人后再发布。审批人为空按 DEC-054 / 098 既有口径（节点无人转异常管理员）。
 */
const ORG_ADJUSTMENT_PRESET: PresetProcess = {
  presetKey: 'standard_organization_process',
  code: 'StandardOrganizationProcess',
  approvalType: 'org_adjustment',
  publishOnProvision: false,
  definition: draft({
    name: '标准组织调整流程',
    description: '出厂预置草稿：审批主体组织的 HRBP → 负责人（取人口径为推断，非原站事实），租户确认后发布',
    priority: 0,
    ...standardCondition('org_adjustment'),
    nodes: [
      node('hrbp_leader', 'HRBPLeader审批', 'approval_subject_org_hrbp', {
        formFields: APPROVAL_TYPES.org_adjustment.formFields,
      }),
      node('hr_head', 'HR负责人审批', 'approval_subject_org_head', {
        formFields: APPROVAL_TYPES.org_adjustment.formFields,
      }),
    ],
  }),
};

/**
 * 试用期考核两类审批（BE-15b1，29 PB-R3，DEC-094 草稿）：员工自评 → 经理评价（节点结构取 PB-R3 “一般为”）。
 * 两个节点都开 “编辑并同意”（审批中可编辑，同意按钮关联编辑）：员工节点只开放自评，经理节点开放评价、转正意见与
 * 转正日期。考核结论决定转正与否，属敏感信息且有重大影响（DEC-332①），经理评价节点显式 avoidSelf = true；员工自评节点
 * 的审批人就是考核对象本人，本就由本人处理，avoidSelf = false（同 IDP 预置的填写节点，K-37）。员工节点不提供驳回
 * （填写节点），经理节点有驳回与“不同意”（不通过，流程结束）。发起人撤回关闭：撤销只对转正申请、不对考核流程（PB-R15）。
 */
const ASSESSMENT_ACTIONS = { ...PRESET_ACTIONS, avoidSubjects: false, revoke: false } as const;
const ASSESSMENT_PRESETS: readonly PresetProcess[] = (
  ['probation_assessment', 'regularization_assessment'] as const
).map((approvalType): PresetProcess => ({
  presetKey: `standard_${approvalType}`,
  code: `Standard_${approvalType}`,
  approvalType,
  definition: draft({
    name: `标准${APPROVAL_TYPES[approvalType].name}流程`,
    description: '出厂预置：员工自评 → 经理评价，发布前须配置异常管理员',
    priority: 0,
    ...standardCondition(approvalType),
    nodes: [
      node('self_evaluation', '员工自评', 'assessment_employee', {
        formFields: ASSESSMENT_FORM_FIELDS,
        editableFields: ['selfEvaluation'],
        editMode: 'with_approve',
        actions: { ...ASSESSMENT_ACTIONS, avoidSelf: false, reject: false },
      }),
      node('manager_review', '经理评价', 'direct_manager', {
        formFields: ASSESSMENT_FORM_FIELDS,
        editableFields: ['managerRating', 'regularizationOpinion', 'regularizationDate'],
        editMode: 'with_approve',
        exits: AGREE_OR_NOT,
        actions: ASSESSMENT_ACTIONS,
      }),
    ],
  }),
}));

export const PRESET_PROCESSES: readonly PresetProcess[] = [
  {
    presetKey: 'standard_transfer',
    code: 'StandardTransfer',
    approvalType: 'transfer',
    definition: {
      name: '标准调动流程',
      groupName: '员工审批流程',
      description: '出厂预置：按本租户调动流程节点结构建立，发布前须配置异常管理员',
      priority: 0,
      isFallback: false,
      exceptionAdminUserId: null,
      urgeEnabled: true,
      hideRecordsFromInitiator: false,
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
        expression: '1',
      },
      nodes: [
        node('out_head', '调出部门负责人审批', 'latest_record_department_head'),
        node('in_hrbp', '调入部门HRBP审核', 'record_department_hrbp', {
          actions: { transfer: true, addSign: true, copySend: true, retrieve: true, reject: true, urge: 'inherit' },
          rejectResubmit: 'rejecting_node',
          messageRules: [
            {
              trigger: 'approve',
              channels: ['inbox', 'email'],
              template: 'TenantBase.Ygddtz',
              recipient: 'subject_employee',
            },
          ],
        }),
        node('in_head', '调入部门负责人审批', 'record_department_head'),
        node('first_level', '单人审批', 'record_first_level_org_head'),
      ],
    },
  },
  {
    presetKey: 'standard_leave',
    code: 'StandardDimission',
    approvalType: 'leave',
    definition: draft({
      name: '标准离职流程',
      description: '出厂预置：直接上级（最新生效主职任职的直线经理） → HR访谈，发布前须配置异常管理员',
      priority: 0,
      isFallback: false,
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }],
        expression: '1',
      },
      nodes: [
        node('direct_head', '直接上级', 'direct_manager', { formFields: LEAVE_FORM }),
        node('hr_interview', 'HR访谈', 'record_department_hrbp', { formFields: LEAVE_FORM }),
      ],
    }),
  },
  {
    presetKey: 'standard_retirement',
    code: 'StandardRetire',
    approvalType: 'retirement',
    definition: draft({
      name: '标准退休流程',
      description: '出厂预置：直接上级（最新生效主职任职的直线经理） → HR访谈，发布前须配置异常管理员',
      priority: 0,
      isFallback: false,
      conditions: {
        items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'RetireProcess' }],
        expression: '1',
      },
      nodes: [
        node('direct_head', '直接上级', 'direct_manager', { formFields: RETIRE_FORM }),
        node('hr_interview', 'HR访谈', 'record_department_hrbp', { formFields: RETIRE_FORM }),
      ],
    }),
  },
  {
    // R2-T04 §11.2：意向退休日期申请预置为本类型兜底流程（原站未发布 IntendedRetireProcess，A-19），直接上级一个节点；
    // 通过只记录、不生效，故无 HR 访谈节点。敏感且有重大影响（DEC-332①），avoidSelf = true
    presetKey: 'standard_retirement_intention',
    code: 'Standard_retirement_intention',
    approvalType: 'retirement_intention',
    definition: draft({
      name: '标准意向退休日期申请流程',
      description: '出厂预置：直接上级审批，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition('retirement_intention'),
      // 驳回 = 退回发起人修改重提；“不同意”= 终态 disapproved，两条出口都留给直接上级
      nodes: [
        node('direct_head', '直接上级', 'direct_manager', {
          formFields: RETIREMENT_INTENTION_FORM_FIELDS,
          exits: AGREE_OR_NOT,
        }),
      ],
    }),
  },
  ...(
    [
      'regularization',
      'intern_regularization',
      'hire',
      'add_employee',
      'contract_create',
      'contract_renew',
      'contract_change',
      'contract_terminate',
    ] as const
  ).map(genericPreset),
  partTimePreset('part_time_add', 'StandardParttimeJob', HRBP_FIRST),
  partTimePreset('part_time_extend', 'StandardExtendParttimeJob', HRBP_FIRST),
  partTimePreset('part_time_end', 'StandardEndParttimeJob', HEAD_FIRST),
  {
    // DEC-116：个人信息变更的发起入口未接入；节点结构未取证（TODO(需取证 #38)），表单待租户按需勾选员工信息字段。
    presetKey: 'standard_emp_info_change',
    code: 'StandardEmpInfoChange',
    approvalType: 'emp_info_change',
    definition: draft({
      name: '标准个人信息变更流程',
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition('emp_info_change'),
      nodes: [node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: [] })],
    }),
  },
  // IDP-R1：预置三条子流程审批流程（制定计划 / 中期回顾 / 期末回顾），节点照原站 W-114 节点链：
  // 发展计划 - 员工本人 → 发展计划 - 指导人（K-09）。
  ...(
    [
      ['idp_plan', 'StandardIdpPlan', '标准制定计划流程', 'set_goals', '制定发展目标', 'approve_plan', '审批发展计划'],
      [
        'idp_mid_review',
        'StandardIdpMidReview',
        '标准中期回顾流程',
        'employee_mid',
        '员工中期回顾',
        'tutor_mid',
        '指导人中期回顾',
      ],
      [
        'idp_final_review',
        'StandardIdpFinalReview',
        '标准期末回顾流程',
        'employee_final',
        '员工期末回顾',
        'tutor_final',
        '指导人期末回顾',
      ],
    ] as const
  ).map(([approvalType, code, name, employeeKey, employeeName, tutorKey, tutorName]): PresetProcess => ({
    presetKey: `standard_${approvalType}`,
    code,
    approvalType,
    definition: draft({
      name,
      description: '出厂预置：员工 → 指导人两个节点，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition(approvalType),
      nodes: [
        // DEC-318：处理人为空照原站“无操作”（K-38）；节点开关见 IDP_ACTIONS（K-37 / K-39）
        node(employeeKey, employeeName, 'idp_employee', {
          formFields: [],
          noAssignee: 'none',
          actions: IDP_EMPLOYEE_ACTIONS,
        }),
        node(tutorKey, tutorName, 'idp_tutor', { formFields: [], noAssignee: 'none', actions: IDP_TUTOR_ACTIONS }),
      ],
    }),
  })),
  {
    // R3-T04 设计 §3.3（D-34，DEC-332①）：盘点结果涉及绩效、潜力等人才评价，影响晋升与继任，敏感且有重大影响，
    // 审批节点显式 avoidSelf = true；集合审批一单涵盖多个被盘点人，avoidSubjects = true（D-34）。预置一旦安装即成为
    // 存量配置，不能等 PR-D 再改模板；节点结构未取证（TODO(需取证 #38) 同口径），由租户调整后发布。
    presetKey: 'standard_talent_review_result',
    code: 'StandardTalentReviewResult',
    approvalType: 'talent_review_result',
    definition: draft({
      name: '标准盘点结果审批流程',
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      ...standardCondition('talent_review_result'),
      nodes: [
        node('department_head', '部门负责人审批', 'latest_record_department_head', {
          formFields: [],
          actions: { ...PRESET_ACTIONS, avoidSubjects: true },
        }),
      ],
    }),
  },
  {
    presetKey: 'standard_personnel_change',
    code: 'StandardPersonnelChange',
    approvalType: 'personnel_change',
    definition: draft({
      name: '标准员工信息变更流程',
      description: '出厂预置：节点结构待按本租户实际流程核对，发布前须配置异常管理员',
      priority: 0,
      isFallback: true,
      conditions: { items: [], expression: '' },
      nodes: [node('department_head', '部门负责人审批', 'latest_record_department_head', { formFields: [] })],
    }),
  },
  ...OFFER_PRESETS,
  ...ASSESSMENT_PRESETS,
  ORG_ADJUSTMENT_PRESET,
];
