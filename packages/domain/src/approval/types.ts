import { CONTRACT_FIELDS, CONTRACT_OBJECT } from '../contracts/rules.js';
/**
 * 审批中心领域模型（R1-T07；docs/02_业务建模/14、REQ-APV-001~004）。
 * 流程按审批类型隔离（DEC-017）；节点是动作开关集 + 消息规则数组（`14` §8.2）；时效字段只预留（DEC-035）。
 */
import { MODULE_OBJECTS } from '../permission/module-actions.js';
import { IDP_APP } from '../idp/catalog.js';
import { PERSONNEL_OBJECT } from '../personnel/catalog.js';
import { EMPLOYEE_EDITABLE_FIELDS, SUBSETS, type SubsetKind } from '../personnel/fields.js';

/** 审批人表达式（REQ-APV-002；F-028 / DEC-230 新增「直接上级」）。 */
export const APPROVER_EXPRESSIONS = [
  'owner', // 流程所有者（发起人）
  'direct_manager', // 直接上级：流程主体员工 → 最新生效主职任职记录 → 直线经理（DEC-230）
  'latest_record_department_head', // 人员 → 最新任职记录 → 部门 → 负责人（调出方）
  'record_department_head', // 本条任职记录 → 部门 → 负责人（调入方）
  'record_department_hrbp', // 本条任职记录 → 部门 → HRBP
  'record_first_level_org_head', // 本条任职记录 → 部门 → 一级组织 → 负责人
  // R3-T07 PR-B（K-09，W-114 节点链）：只有 IDP 三类审批类型可选（IDP_ONLY_APPROVERS）
  'idp_employee', // 发展计划 - 员工本人（填写节点，不按自审处理，K-37）
  'idp_tutor', // 发展计划 - 指导人
] as const;
export type ApproverExpression = (typeof APPROVER_EXPRESSIONS)[number];

/** 只在 IDP 审批类型上可用的审批人表达式（取发展计划上的员工 / 指导人）。 */
export const IDP_ONLY_APPROVERS: ReadonlySet<ApproverExpression> = new Set(['idp_employee', 'idp_tutor']);

/**
 * 审批人为空：首节点提交即报错，中间节点一律转异常管理员（DEC-054、REQ-APV-002 R6、`14` §10）。
 * 原站另有“自动跳过 / 自动同意”配置（`14` §8.7），复刻首版不开放（PR #35 第二轮清单 6）。
 */
/**
 * 审批人为空的处理：转异常管理员（DEC-054 / 098）；无操作（DEC-318 K-38，原站 noAssignee.type = 0：不转管理员、不自动
 * 跳过，推进到该节点的操作报错，流程停在原节点，🟡 原站报错文案未实测）。
 */
export const NO_ASSIGNEE_POLICIES = ['exception_admin', 'none'] as const;
export type NoAssigneePolicy = (typeof NO_ASSIGNEE_POLICIES)[number];

/** 审批中编辑：独立【编辑】按钮（保存后仍需同意）/ 与【同意】合一（REQ-APV-003 R2）。 */
export const EDIT_MODES = ['none', 'separate', 'with_approve'] as const;
export type EditMode = (typeof EDIT_MODES)[number];

/** 驳回到发起人后同单重提：从首节点重新走 / 直接提交到驳回节点（`14` §8.2，DEC-053）。 */
export const REJECT_RESUBMIT_MODES = ['restart', 'rejecting_node'] as const;
export type RejectResubmitMode = (typeof REJECT_RESUBMIT_MODES)[number];

/** 消息触发动作：到达、同意、不同意（DEC-144 出口动作）、驳回、转交。 */
export const MESSAGE_TRIGGERS = ['arrive', 'approve', 'disagree', 'reject', 'transfer'] as const;
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

/** 节点类型（F-003，`14` §11.4、§12）：单人审批 / 会签审批（多名审批人同时审批、无先后）。 */
export const NODE_KINDS = ['single', 'countersign'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * 加签类型（`14` §11.4）。单人审批节点（DEC-095）：前加签 = 加签人按选择顺序依次先审、全部同意后回到原审批人；
 * 后加签 = 原审批人同意后加签人依次审批，全部完成才离开本节点。会签审批节点（DEC-117 / F-003）：并加签 = 加签人
 * 与原审批人同时审批、无先后，计入节点流转规则（DEC-144）；前加签（DEC-152）按席位生效、不计入流转规则
 * （policies.addSignerVotes）。
 */
export const ADD_SIGN_TYPES = ['before', 'after', 'parallel'] as const;
export type AddSignType = (typeof ADD_SIGN_TYPES)[number];
/**
 * 各类节点可用的加签类型：会签节点有并加签，另有前加签（原站 2024-06 起，组织人事 2024-07 开放，`14` §11.4；
 * DEC-152 并入 F-003）；会签节点请求后加签、单人节点请求并加签返回明确错误。
 */
export const NODE_ADD_SIGN_TYPES: Readonly<Record<NodeKind, readonly AddSignType[]>> = {
  single: ['before', 'after'],
  countersign: ['before', 'parallel'],
};
/** 单次加签的人数上限（DEC-101：只限制单次操作规模）。 */
export const MAX_ADD_SIGNERS = 10;

/**
 * 节点出口动作（出口连线上的动作，DEC-144，`14` §12.2）：「同意」「不同意」都按流转规则计数，达到规则即沿该动作的
 * 连线流转（EXIT_TARGETS）。「驳回」是节点开关（NodeActions.reject）、不是出口动作，不进流转规则。缺省只有「同意」，
 * R1-T07 起的节点行为不变；自定义动作的出口线首版不做。
 */
export const NODE_EXITS = ['approve', 'disagree'] as const;
export type NodeExit = (typeof NODE_EXITS)[number];
/**
 * 出口连线的去向。复刻首版的流程是线性的：「同意」进入下一节点；「不同意」连到结束——流程结束、业务不生效，不进入
 * 可修改重提的“退回”（原站本租户的不同意连线都连到结束，面板提示“任一审批人不同意，流程流转结束”，`14` §12.2）。
 */
export const EXIT_TARGETS: Readonly<Record<NodeExit, 'next' | 'end'>> = { approve: 'next', disagree: 'end' };
export const DEFAULT_EXITS: readonly NodeExit[] = ['approve'];
export const EXIT_LABELS: Readonly<Record<NodeExit, string>> = { approve: '同意', disagree: '不同意' };

/**
 * 会签流转规则（DEC-144，`14` §12.1）：任一人同意即可（新会签节点默认）/ 需所有人同意 / 自定义审批方式。
 * 自定义时按出口动作逐行设“整数 N 人”或“百分比（向上取整）”；判定见 countersign.ts。
 */
export const TRANSITION_RULE_TYPES = ['any', 'all', 'custom'] as const;
export type TransitionRuleType = (typeof TRANSITION_RULE_TYPES)[number];
export const EXIT_RULE_KINDS = ['count', 'percent'] as const;
export type ExitRuleKind = (typeof EXIT_RULE_KINDS)[number];
export interface ExitRule {
  readonly kind: ExitRuleKind;
  /** 整数：≥ 1 的人数；百分比：(0, 100]，最多两位小数。 */
  readonly value: number;
}
export type ExitRules = Readonly<Partial<Record<NodeExit, ExitRule>>>;
export interface TransitionRule {
  readonly type: TransitionRuleType;
  /** 只有自定义审批方式逐行给出；两种预设按节点出口动作生成（countersign.exitRulesOf）。 */
  readonly rules?: ExitRules;
}

/**
 * 相同 / 历史相同审批人自动处理的结果（DEC-106，`14` §11.6）：「同意」记为该审批人同意；「跳过」沿同意路径流转、
 * 处理人记为系统。节点其他出口线动作（含「不同意」）首版不做；审批人为空不适用（DEC-054）。
 */
export const AUTO_RESULTS = ['approve', 'skip'] as const;
export type AutoResult = (typeof AUTO_RESULTS)[number];

/** 节点动作开关集（`14` §8.2：抄送 / 转交 / 撤回 / 加签 / 驳回 / 催办），随流程版本冻结（DEC-097）。 */
export interface NodeActions {
  readonly transfer: boolean;
  readonly addSign: boolean;
  /**
   * 驳回（驳回到发起人）：节点开关（原站 `isRejectToStart`，`14` §12.2），单人与会签节点共用，加签人的驳回权限沿用
   * 原节点开关（`14` §11.4）。缺省（未给出）即开启——R1-T07 起的节点一直可以驳回（rejectAllowed）。复刻只有
   * “驳回到发起人”一种去向。
   */
  readonly reject?: boolean;
  /** 抄送：审批人手动选人抄送（`isCopySend`，原站无固定抄送对象清单）。 */
  readonly copySend: boolean;
  /** 审批人撤回：下一节点尚未处理时撤回本人的同意（`isRetrieve`）。 */
  readonly retrieve: boolean;
  readonly urge: UrgeMode;
  /**
   * 自审回避（DEC-058 / DEC-068 / DEC-091 的“发起人 / 异动本人不审批自己的单据”）：路由时自审跳过转直线经理、办理时
   * 拒绝本人。DEC-318 K-37 起是节点开关（原站跳过类开关都是节点级）；缺省（未给出）即开启，原有流程行为不变。
   * IDP 预置流程关闭（员工处理自己计划的节点是正常路径）。
   */
  readonly avoidSelf?: boolean;
}

/** 节点是否自审回避：未给出即开启（NodeActions.avoidSelf）。 */
export function avoidsSelf(node: { readonly actions?: Pick<NodeActions, 'avoidSelf'> }): boolean {
  return node.actions?.avoidSelf !== false;
}

/** 节点是否开启驳回：未给出即开启（NodeActions.reject）。 */
export function rejectAllowed(node: Pick<ApprovalNode, 'actions'>): boolean {
  return node.actions.reject !== false;
}

/** 节点最终是否允许催办：节点开启 / 关闭覆盖流程设置，继承时取流程设置（X-15）。 */
export function urgeAllowed(processUrgeEnabled: boolean, node: Pick<ApprovalNode, 'actions'>): boolean {
  return node.actions.urge === 'inherit' ? processUrgeEnabled : node.actions.urge === 'enabled';
}

interface ApprovalNodeBase {
  readonly key: string;
  readonly name: string;
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
  /** 出口动作（DEC-144）；缺省只有「同意」（DEFAULT_EXITS）。 */
  readonly exits?: readonly NodeExit[];
}

/** 单人审批节点：一个审批人表达式（R1-T07 起的节点；类型缺省即单人）。 */
export interface SingleApprovalNode extends ApprovalNodeBase {
  readonly kind?: 'single';
  readonly approver: ApproverExpression;
}

/**
 * 会签审批节点（F-003）：多个审批人表达式逐人解析，审批人同时审批、无先后；按流转规则判定沿哪个出口动作流转
 * （DEC-144）。审批人为空、自审、相同 / 历史相同审批人自动处理都逐人生效；自动处理的结果只能是「同意」（DEC-106）。
 */
export interface CountersignApprovalNode extends ApprovalNodeBase {
  readonly kind: 'countersign';
  readonly approvers: readonly ApproverExpression[];
  readonly transitionRule: TransitionRule;
}

export type ApprovalNode = SingleApprovalNode | CountersignApprovalNode;

export function isCountersign(node: ApprovalNode): node is CountersignApprovalNode {
  return node.kind === 'countersign';
}

export function nodeKindOf(node: ApprovalNode): NodeKind {
  return node.kind ?? 'single';
}

/** 节点逐人解析的审批人表达式：单人节点一个，会签节点按配置顺序多个。 */
export function approverExpressionsOf(node: ApprovalNode): readonly ApproverExpression[] {
  return isCountersign(node) ? node.approvers : [node.approver];
}

export function nodeExits(node: Pick<ApprovalNode, 'exits'>): readonly NodeExit[] {
  return node.exits ?? DEFAULT_EXITS;
}

export function hasExit(node: Pick<ApprovalNode, 'exits'>, exit: NodeExit): boolean {
  return nodeExits(node).includes(exit);
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

const EMPLOYEE_INFO_CONDITION_FIELDS: readonly ConditionField[] = PERSONNEL_CONDITION_FIELDS.filter(
  (field) => field.path !== 'request.subset',
);

/**
 * 任职类审批表单可带出的员工档案只读字段（DEC-122：调动审批详情的性别、年龄）：值取员工档案，按员工信息对象
 * 的字段查看权裁剪，不能配置为可编辑字段。
 */
export const PROFILE_FORM_FIELDS = ['gender', 'age'] as const;

const employmentFormFields = [
  ...MODULE_OBJECTS.employmentRecord.fields.filter((f) => !f.system).map((f) => f.code),
  ...PROFILE_FORM_FIELDS,
];
const personnelFormFields = [...new Set(Object.values(SUBSETS).flatMap((subset) => subset.fields.map((f) => f.code)))];
const employeeInfoFormFields = EMPLOYEE_EDITABLE_FIELDS.filter((f) => !f.system).map((f) => f.code);

/**
 * employee_info：个人信息变更（员工信息主表），发起入口留待后续业务接入（DEC-116），尚无运行时适配器。
 * idp：个人发展计划的子流程（R3-T07）：PR-A 登记类型供子流程引用与节点配置，PR-B 接入运行时适配器（一个阶段一条实例）。
 */
export type ApprovalAdapterKind = 'employment' | 'personnel_change' | 'employee_info' | 'contract' | 'idp';
export interface ApprovalTypeDefinition {
  readonly code: string;
  readonly name: string;
  readonly objectCode: string;
  readonly adapter: ApprovalAdapterKind;
  /** 发起入口默认携带的标准流程编码（`14` §11.1）；原站没有对应标准流程的类型为空。 */
  readonly defaultProcessCode: string | null;
  readonly conditionFields: readonly ConditionField[];
  readonly formFields: readonly string[];
  /** 表单上只读的带出字段（不能配置为可编辑字段）。 */
  readonly readonlyFields: readonly string[];
  /** 是否开放审批中编辑（REQ-APV-003 R2）；员工信息类首版不做（DEC-105），配置与详情动作都按此判断。 */
  readonly approvalEdit: boolean;
}

/** 发展计划对象（IDP.Idp）：IDP 审批实例的业务对象。 */
const IDP_PLAN_OBJECT = `${IDP_APP}.Idp`;

const employmentType = (code: string, name: string, defaultProcessCode: string | null = null) =>
  ({
    code,
    name,
    objectCode: MODULE_OBJECTS.employmentRecord.code,
    adapter: 'employment',
    defaultProcessCode,
    conditionFields: EMPLOYMENT_CONDITION_FIELDS,
    formFields: employmentFormFields,
    readonlyFields: PROFILE_FORM_FIELDS,
    approvalEdit: true,
  }) as const satisfies ApprovalTypeDefinition;

/**
 * 审批类型目录（`14` §11.1，原站 88 个类型中首版涉及的任职记录类型 + 员工信息类型）。原站没有“重聘”审批类型：
 * 重聘入职、退休返聘是「入职」的异动类型（`07` §2），走入职审批（approvalTypeOfBusiness）。
 * 原站「组织调整」审批类型挂在组织调整申请对象上（`33`），任职记录上的组织调整异动没有对应的标准流程编码。
 */
const contractType = (code: string, name: string, defaultProcessCode: string) =>
  ({
    code,
    name,
    defaultProcessCode,
    objectCode: CONTRACT_OBJECT,
    adapter: 'contract',
    conditionFields: EMPLOYMENT_CONDITION_FIELDS.filter((f) => ['processCode', 'business.kind'].includes(f.path)),
    formFields: CONTRACT_FIELDS,
    readonlyFields: [],
    approvalEdit: false,
  }) as const satisfies ApprovalTypeDefinition;

/**
 * IDP 子流程的三类审批流程（`28` IDP-R1；Q-M0-115② 子流程“名称（关联审批流程）”制定计划 1 / 中期回顾 2 / 末期回顾 3）。
 * 原站没有标准流程编码；审批不带业务表单字段与发起条件（计划内容在 IDP 内按节点按钮维护，DEC-296④）。
 */
const idpType = (code: string, name: string) =>
  ({
    code,
    name,
    objectCode: IDP_PLAN_OBJECT,
    adapter: 'idp',
    defaultProcessCode: null,
    conditionFields: [],
    formFields: [],
    readonlyFields: [],
    approvalEdit: false,
  }) as const satisfies ApprovalTypeDefinition;

export const APPROVAL_TYPES = {
  contract_create: contractType('contract_create', '新建合同', 'AddContractApproval'),
  contract_renew: contractType('contract_renew', '续签合同', 'RenewContractProcess'),
  contract_change: contractType('contract_change', '变更合同', 'ChangeContractProcess'),
  contract_terminate: contractType('contract_terminate', '终止合同', 'TerminateContractProcess'),
  transfer: employmentType('transfer', '调动', 'TransferProcessNew'),
  leave: employmentType('leave', '离职', 'DimissionProcessNew'),
  regularization: employmentType('regularization', '转正', 'ProbationProcessNew'),
  intern_regularization: employmentType('intern_regularization', '实习转正', 'TraineeEntryProcess'),
  hire: employmentType('hire', '入职', 'EntryProcessNew'),
  retirement: employmentType('retirement', '退休', 'RetireProcess'),
  org_adjustment: employmentType('org_adjustment', '组织调整'),
  // DEC-116（代选）：「新增员工」「个人信息变更」先建类型与草稿预置，发起入口随后续业务接入。
  add_employee: employmentType('add_employee', '新增员工', 'AddEmployeeProcess'),
  emp_info_change: {
    code: 'emp_info_change',
    name: '个人信息变更',
    objectCode: PERSONNEL_OBJECT,
    adapter: 'employee_info',
    defaultProcessCode: 'EmpInfoChangeProcess',
    conditionFields: EMPLOYEE_INFO_CONDITION_FIELDS,
    formFields: employeeInfoFormFields,
    readonlyFields: [],
    approvalEdit: false,
  },
  idp_plan: idpType('idp_plan', '制定计划'),
  idp_mid_review: idpType('idp_mid_review', '中期回顾'),
  idp_final_review: idpType('idp_final_review', '末期回顾'),
  personnel_change: {
    code: 'personnel_change',
    name: '员工子集变更',
    objectCode: 'TenantBase.PersonalInformationChange',
    adapter: 'personnel_change',
    defaultProcessCode: null,
    conditionFields: PERSONNEL_CONDITION_FIELDS,
    formFields: personnelFormFields,
    readonlyFields: [],
    approvalEdit: false,
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
  // 「新增员工」还没有对应的任职业务入口（DEC-116），任职业务不会落到它。
  return isApprovalType(mapped) && APPROVAL_TYPES[mapped].adapter === 'employment' && mapped !== 'add_employee'
    ? mapped
    : null;
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
