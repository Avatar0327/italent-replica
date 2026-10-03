/**
 * 审批中心领域模型（R1-T07；docs/02_业务建模/14、REQ-APV-001~004）。
 * 流程按审批类型隔离（DEC-017）；节点是动作开关集 + 消息规则数组（`14` §8.2）；时效字段只预留（DEC-035）。
 */
import { MODULE_OBJECTS } from '../permission/module-actions.js';
import { SUBSETS } from '../personnel/fields.js';

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

export interface NodeActions {
  readonly transfer: boolean;
  readonly addSign: boolean;
  readonly urge: boolean;
}

export interface ApprovalNode {
  readonly key: string;
  readonly name: string;
  readonly approver: ApproverExpression;
  readonly noAssignee: NoAssigneePolicy;
  readonly sameAssigneeSkip: boolean;
  readonly historySameAssigneeSkip: boolean;
  readonly formFields: readonly string[];
  readonly editableFields: readonly string[];
  readonly editMode: EditMode;
  readonly actions: NodeActions;
  /** DEC-059：出厂关闭。 */
  readonly rejectCommentRequired: boolean;
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
  /** 发起入口默认携带的流程编码（`13` §6.3）；未取证的类型不预设。 */
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
 * 审批类型目录：任职业务各类型一一对应（`14` §5 审批类型管理）；人员自助变更为“员工子集变更”。
 * TODO(需取证 Q-M0-38)：原站审批类型字典的完整编码、名称与各类型标准流程编码。
 */
export const APPROVAL_TYPES = {
  transfer: employmentType('transfer', '调动', 'TransferProcessNew'),
  leave: employmentType('leave', '离职', 'DimissionProcessNew'),
  regularization: employmentType('regularization', '转正'),
  intern_regularization: employmentType('intern_regularization', '实习生转正'),
  hire: employmentType('hire', '新增员工'),
  rehire: employmentType('rehire', '重新入职'),
  retire_rehire: employmentType('retire_rehire', '退休返聘'),
  retirement: employmentType('retirement', '退休'),
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

export function approvalType(code: ApprovalTypeCode): ApprovalTypeDefinition {
  return APPROVAL_TYPES[code];
}
