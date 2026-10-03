/**
 * 审批中心领域模型（R1-T07；docs/02_业务建模/14、REQ-APV-001~004）。
 * 流程按审批类型隔离（DEC-017）；节点是动作开关集 + 消息规则数组（`14` §8.2）；时效字段只预留（DEC-035）。
 */
import { MODULE_OBJECTS } from '../permission/module-actions.js';
import { SUBSETS, type SubsetKind } from '../personnel/fields.js';

/** 首版五种审批人表达式（REQ-APV-002「首版最小表达式集」）。 */
export const APPROVER_EXPRESSIONS = [
  'owner', // 流程所有者（发起人）
  'latest_record_department_head', // 人员 → 最新任职记录 → 部门 → 负责人（调出方）
  'record_department_head', // 本条任职记录 → 部门 → 负责人（调入方）
  'record_department_hrbp', // 本条任职记录 → 部门 → HRBP
  'record_first_level_org_head', // 本条任职记录 → 部门 → 一级组织 → 负责人
] as const;
export type ApproverExpression = (typeof APPROVER_EXPRESSIONS)[number];

/**
 * 审批人为空：首节点提交即报错，中间节点一律转异常管理员（DEC-054、REQ-APV-002 R6、`14` §10）。
 * 原站另有“自动跳过 / 自动同意”配置（`14` §8.7），复刻首版不开放（PR #35 第二轮清单 6）。
 */
export const NO_ASSIGNEE_POLICIES = ['exception_admin'] as const;
export type NoAssigneePolicy = (typeof NO_ASSIGNEE_POLICIES)[number];

/** 审批中编辑：独立【编辑】按钮（保存后仍需同意）/ 与【同意】合一（REQ-APV-003 R2）。 */
export const EDIT_MODES = ['none', 'separate', 'with_approve'] as const;
export type EditMode = (typeof EDIT_MODES)[number];

/** 驳回到发起人后同单重提：从首节点重新走 / 直接提交到驳回节点（`14` §8.2，DEC-053）。 */
export const REJECT_RESUBMIT_MODES = ['restart', 'rejecting_node'] as const;
export type RejectResubmitMode = (typeof REJECT_RESUBMIT_MODES)[number];

export const MESSAGE_TRIGGERS = ['arrive', 'approve', 'reject', 'transfer'] as const;
export const MESSAGE_CHANNELS = ['inbox', 'email', 'sms'] as const;
/** 消息接收人表达式：流程所有者（发起人）/ 异动员工本人 / 本节点审批人。 */
export const MESSAGE_RECIPIENTS = ['owner', 'subject_employee', 'assignee'] as const;

export interface MessageRule {
  readonly trigger: (typeof MESSAGE_TRIGGERS)[number];
  readonly channels: readonly (typeof MESSAGE_CHANNELS)[number][];
  readonly template: string;
  readonly recipient: (typeof MESSAGE_RECIPIENTS)[number];
}

/** 节点催办：继承流程设置 / 本节点开启 / 本节点关闭（X-15，`14` 节点动作覆盖流程级“催办设置”）。 */
export const URGE_MODES = ['inherit', 'enabled', 'disabled'] as const;
export type UrgeMode = (typeof URGE_MODES)[number];

/**
 * 加签类型（DEC-095，`14` §11.4 单人审批节点）：前加签 = 加签人按选择顺序依次先审、全部同意后回到原审批人；
 * 后加签 = 原审批人同意后加签人依次审批，全部完成才离开本节点。会签节点的并加签不适用（首版节点均为单人审批）。
 */
export const ADD_SIGN_TYPES = ['before', 'after'] as const;
export type AddSignType = (typeof ADD_SIGN_TYPES)[number];
/** 单次加签的人数上限（DEC-101：只限制单次操作规模）。 */
export const MAX_ADD_SIGNERS = 10;

/**
 * 相同 / 历史相同审批人自动处理的结果（DEC-106，`14` §11.6）：「同意」记为该审批人同意；「跳过」沿同意路径流转、
 * 处理人记为系统。节点其他出口线动作（含「不同意」）首版不做；审批人为空不适用（DEC-054）。
 */
export const AUTO_RESULTS = ['approve', 'skip'] as const;
export type AutoResult = (typeof AUTO_RESULTS)[number];

/** 节点动作开关集（`14` §8.2：抄送 / 转交 / 撤回 / 加签 / 催办），随流程版本冻结（DEC-097）。 */
export interface NodeActions {
  readonly transfer: boolean;
  readonly addSign: boolean;
  /** 抄送：审批人手动选人抄送（`isCopySend`，原站无固定抄送对象清单）。 */
  readonly copySend: boolean;
  /** 审批人撤回：下一节点尚未处理时撤回本人的同意（`isRetrieve`）。 */
  readonly retrieve: boolean;
  readonly urge: UrgeMode;
}

/** 节点最终是否允许催办：节点开启 / 关闭覆盖流程设置，继承时取流程设置（X-15）。 */
export function urgeAllowed(processUrgeEnabled: boolean, node: Pick<ApprovalNode, 'actions'>): boolean {
  return node.actions.urge === 'inherit' ? processUrgeEnabled : node.actions.urge === 'enabled';
}

export interface ApprovalNode {
  readonly key: string;
  readonly name: string;
  readonly approver: ApproverExpression;
  readonly noAssignee: NoAssigneePolicy;
  readonly sameAssigneeSkip: boolean;
  readonly historySameAssigneeSkip: boolean;
  readonly sameAssigneeResult: AutoResult;
  readonly historySameAssigneeResult: AutoResult;
  readonly formFields: readonly string[];
  readonly editableFields: readonly string[];
  readonly editMode: EditMode;
  readonly actions: NodeActions;
  /** DEC-059：出厂关闭。 */
  readonly rejectCommentRequired: boolean;
  /**
   * DEC-104「审批记录查看权限」：查看方的设置，勾选后本节点审批人进入详情页时看不到审批记录与沟通（`14` §11.9）。
   * 出厂关闭 = 所有能打开详情页的人都看得到（DEC-100）。
   */
  readonly hideRecords: boolean;
  readonly rejectResubmit: RejectResubmitMode;
  readonly messageRules: readonly MessageRule[];
}

export const CONDITION_OPERATORS = ['eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty', 'in_org_tree'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface ConditionItem {
  readonly no: number;
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value: string | readonly string[] | null;
}

export interface ProcessCondition {
  readonly items: readonly ConditionItem[];
  /** 高级表达式，如 `1 and (2 or 3)`；为空时按全部条目 AND 组合。 */
  readonly expression: string;
}

/** 流程版本的可编辑属性（已发布版本只读，REQ-APV-001 R1）。 */
export interface ProcessDefinition {
  readonly name: string;
  readonly groupName: string | null;
  readonly description: string | null;
  readonly priority: number;
  /** DEC-018：显式声明为本业务类型内的兜底流程时，发起条件可为空。 */
  readonly isFallback: boolean;
  readonly exceptionAdminUserId: string | null;
  readonly urgeEnabled: boolean;
  /** DEC-104：开始节点上的「审批记录查看权限」，勾选后发起人看不到审批记录与沟通。 */
  readonly hideRecordsFromInitiator: boolean;
  readonly conditions: ProcessCondition;
  readonly nodes: readonly ApprovalNode[];
}

/** 条件字段白名单（不做通用表达式引擎，R3-T00 接入前只开放这些路径）。 */
export type ConditionFieldKind = 'text' | 'org' | 'reference' | 'date';
export interface ConditionField {
  readonly path: string;
  readonly label: string;
  readonly kind: ConditionFieldKind;
}

const EMPLOYMENT_CONDITION_FIELDS: readonly ConditionField[] = [
  { path: 'processCode', label: '流程编码', kind: 'text' },
  { path: 'business.kind', label: '业务类型', kind: 'text' },
  { path: 'employee.code', label: '任职人员 - 工号', kind: 'text' },
  { path: 'employee.name', label: '任职人员 - 姓名', kind: 'text' },
  { path: 'before.departmentId', label: '变动前部门', kind: 'org' },
  { path: 'record.departmentId', label: '本条记录部门', kind: 'org' },
  { path: 'before.postId', label: '变动前职务', kind: 'reference' },
  { path: 'record.postId', label: '本条记录职务', kind: 'reference' },
  { path: 'before.positionId', label: '变动前职位', kind: 'reference' },
  { path: 'record.positionId', label: '本条记录职位', kind: 'reference' },
  { path: 'before.levelId', label: '变动前职级', kind: 'reference' },
  { path: 'record.levelId', label: '本条记录职级', kind: 'reference' },
  { path: 'record.effectiveDate', label: '生效日期', kind: 'date' },
];

const PERSONNEL_CONDITION_FIELDS: readonly ConditionField[] = [
  { path: 'processCode', label: '流程编码', kind: 'text' },
  { path: 'employee.code', label: '员工 - 工号', kind: 'text' },
  { path: 'employee.name', label: '员工 - 姓名', kind: 'text' },
  { path: 'employee.departmentId', label: '员工 - 当前部门', kind: 'org' },
  { path: 'request.subset', label: '变更子集', kind: 'text' },
];

const employmentFormFields = MODULE_OBJECTS.employmentRecord.fields.filter((f) => !f.system).map((f) => f.code);
const personnelFormFields = [...new Set(Object.values(SUBSETS).flatMap((subset) => subset.fields.map((f) => f.code)))];

export type ApprovalAdapterKind = 'employment' | 'personnel_change';
export interface ApprovalTypeDefinition {
  readonly code: string;
  readonly name: string;
  readonly objectCode: string;
  readonly adapter: ApprovalAdapterKind;
  /** 发起入口默认携带的标准流程编码（`14` §11.1）；原站没有对应标准流程的类型为空。 */
  readonly defaultProcessCode: string | null;
  readonly conditionFields: readonly ConditionField[];
  readonly formFields: readonly string[];
}

const employmentType = (code: string, name: string, defaultProcessCode: string | null = null) =>
  ({
    code,
    name,
    objectCode: MODULE_OBJECTS.employmentRecord.code,
    adapter: 'employment',
    defaultProcessCode,
    conditionFields: EMPLOYMENT_CONDITION_FIELDS,
    formFields: employmentFormFields,
  }) as const satisfies ApprovalTypeDefinition;

/**
 * 审批类型目录（`14` §11.1，原站 88 个类型中首版涉及的任职记录类型 + 员工子集变更）。原站没有“重聘”审批类型：
 * 重聘入职、退休返聘是「入职」的异动类型（`07` §2），走入职审批（approvalTypeOfBusiness）。
 * 原站「组织调整」审批类型挂在组织调整申请对象上（`33`），任职记录上的组织调整异动没有对应的标准流程编码。
 */
export const APPROVAL_TYPES = {
  transfer: employmentType('transfer', '调动', 'TransferProcessNew'),
  leave: employmentType('leave', '离职', 'DimissionProcessNew'),
  regularization: employmentType('regularization', '转正', 'ProbationProcessNew'),
  intern_regularization: employmentType('intern_regularization', '实习转正', 'TraineeEntryProcess'),
  hire: employmentType('hire', '入职', 'EntryProcessNew'),
  retirement: employmentType('retirement', '退休', 'RetireProcess'),
  org_adjustment: employmentType('org_adjustment', '组织调整'),
  personnel_change: {
    code: 'personnel_change',
    name: '员工子集变更',
    objectCode: 'TenantBase.PersonalInformationChange',
    adapter: 'personnel_change',
    defaultProcessCode: null,
    conditionFields: PERSONNEL_CONDITION_FIELDS,
    formFields: personnelFormFields,
  },
} as const satisfies Record<string, ApprovalTypeDefinition>;
export type ApprovalTypeCode = keyof typeof APPROVAL_TYPES;

export function isApprovalType(value: string): value is ApprovalTypeCode {
  return Object.hasOwn(APPROVAL_TYPES, value);
}

/** 任职业务类型 → 审批类型：重聘入职、退休返聘归入「入职」（`07` §2、`14` §11.1）。 */
const ENTRY_KINDS: Readonly<Record<string, ApprovalTypeCode>> = { rehire: 'hire', retire_rehire: 'hire' };

export function approvalTypeOfBusiness(kind: string): ApprovalTypeCode | null {
  const mapped = ENTRY_KINDS[kind] ?? kind;
  return isApprovalType(mapped) && mapped !== 'personnel_change' ? mapped : null;
}

/** 员工子集变更按子集各用自己的标准流程编码（`14` §11.1，手册 185008911）；未取到标准编码的子集为空。 */
const SUBSET_PROCESS_CODES: Readonly<Partial<Record<SubsetKind, string>>> = {
  education: 'ChangeEducationProcess',
  family: 'ChangeFamilyProcess',
  jobhistory: 'ChangeJobHistoryProcess',
  training: 'ChangeTrainingProcess',
  'project-experience': 'ChangeProjectExperienceProcess',
  awards: 'ChangeAwardsProcess',
  'language-ability': 'LanguageSkillsChange',
  skill: 'ProfessionalSkillsChange',
  punish: 'ChangePunishProcess',
  certificate: 'ChangeCertificateProcess',
};

export function subsetProcessCode(subset: SubsetKind): string | null {
  return SUBSET_PROCESS_CODES[subset] ?? null;
}

export function approvalType(code: ApprovalTypeCode): ApprovalTypeDefinition {
  return APPROVAL_TYPES[code];
}
