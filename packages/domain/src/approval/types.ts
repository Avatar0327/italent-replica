import { CONTRACT_FIELDS, CONTRACT_OBJECT } from '../contracts/rules.js';
import { OFFER_BATCH_FIELDS, OFFER_BATCH_OBJECT, OFFER_BATCH_PROCESS_CODE } from '../offer/approval.js';
import { OFFER_FIELDS, OFFER_OBJECT } from '../offer/rules.js';
import {
  ORG_ADJUSTMENT_FORM_FIELDS,
  ORG_ADJUSTMENT_OBJECT_CODE,
  ORG_ADJUSTMENT_PROCESS_CODE,
} from '../org-adjustment/fields.js';
import { ASSESSMENT_FORM_FIELDS, PROBATION_ASSESSMENT_OBJECT } from '../employment/assessment.js';
import { RETIREMENT_REQUEST_FIELDS } from '../employment/retirement.js';
import {
  RETIREMENT_INTENTION_FORM_FIELDS,
  RETIREMENT_INTENTION_SNAPSHOT_FIELDS,
} from '../employment/retirement-intention.js';
/**
 * 审批中心领域模型（R1-T07；docs/02_业务建模/14、REQ-APV-001~004）。
 * 流程按审批类型隔离（DEC-017）；节点是动作开关集 + 消息规则数组（`14` §8.2）；时效字段只预留（DEC-035）。
 */
import { MODULE_OBJECTS } from '../permission/module-actions.js';
import { IDP_APP } from '../idp/catalog.js';
import { TALENT_REVIEW_OBJECTS } from '../talent-review/catalog.js';
import { PERSONNEL_OBJECT } from '../personnel/catalog.js';
import { EMPLOYEE_EDITABLE_FIELDS, SUBSETS, type SubsetKind } from '../personnel/fields.js';

/** 审批人表达式（REQ-APV-002；F-028 / DEC-230 新增「直接上级」）。 */
export const APPROVER_EXPRESSIONS = [
  'owner', // 流程所有者（发起人）
  'direct_manager', // 直接上级：流程主体员工 → 最新生效主职任职记录 → 直线经理（DEC-230）
  'latest_record_department_head', // 人员 → 最新任职记录 → 部门 → 负责人（调出方）
  // BE-7 兼职预置（R2-T05 §1.5）：人员 → 最新主职任职 → 部门 → HRBP（“主职部门 HRBP”）
  'latest_record_department_hrbp',
  'record_department_head', // 本条任职记录 → 部门 → 负责人（调入方）
  'record_department_hrbp', // 本条任职记录 → 部门 → HRBP
  'record_first_level_org_head', // 本条任职记录 → 部门 → 一级组织 → 负责人
  // R3-T07 PR-B（K-09，W-114 节点链）：只有 IDP 三类审批类型可选（IDP_ONLY_APPROVERS）
  'idp_employee', // 发展计划 - 员工本人（填写节点，不按自审处理，K-37）
  'idp_tutor', // 发展计划 - 指导人
  // R2 BE-14a3（F-171 ①②，OF-R15）：只有 Offer 两类审批可选（OFFER_APPROVERS）
  'offer_department_head', // Offer 审批 - 录用部门负责人
  'initiator_direct_manager', // 申请人直接上级：发起人 → 最新生效主职任职 → 直线经理（区别于取流程主体的 direct_manager）
  'approval_subject_first_level_org_head', // Offer 批量审批 - 审批主体组织 → 一级组织 → 负责人
  // R2 BE-15b1（29 PB-R3）：只有试用期考核两类审批可选（ASSESSMENT_ONLY_APPROVERS）
  'assessment_employee', // 考核 - 考核对象本人（员工自评节点，不按自审处理，同 idp_employee）
  // R2-T08 BE-10a（§4.2）：只有组织调整可选（ORG_ADJUSTMENT_APPROVERS），取审批主体组织的 HRBP / 负责人
  'approval_subject_org_hrbp',
  'approval_subject_org_head',
  // R2 BE-8b2（B64，原站未验证，取保守做法）：只有离职交接申请可选（HANDOVER_ONLY_APPROVERS）
  'handover_work_owner', // 离职交接 - 工作交接：离职申请的交接人，没填取直线经理
  'handover_hr_admin', // 离职交接 - 其他事项交接：人事管理员角色（standard_hr_admin 的有效授权人，按授权先后取首个可用者）
  'handover_employee', // 离职交接 - 员工确认：离职员工本人（不按自审处理）
] as const;
export type ApproverExpression = (typeof APPROVER_EXPRESSIONS)[number];

/** 只在 IDP 审批类型上可用的审批人表达式（取发展计划上的员工 / 指导人）。 */
export const IDP_ONLY_APPROVERS: ReadonlySet<ApproverExpression> = new Set(['idp_employee', 'idp_tutor']);

/**
 * Offer 两类审批的审批人白名单（BE-14a3）：候选人不是员工，流程主体与任职记录类取值都取不到人，只开放这几项；
 * 批量审批不得用“录用部门负责人”（OF-R15）。三个新取值也只用于这两类，不改其他业务的审批行为。
 */
export const OFFER_APPROVERS: Readonly<Record<'offer' | 'offer_batch', ReadonlySet<ApproverExpression>>> = {
  offer: new Set(['owner', 'initiator_direct_manager', 'offer_department_head']),
  offer_batch: new Set(['owner', 'initiator_direct_manager', 'approval_subject_first_level_org_head']),
};
/** 只在试用期考核两类审批上可用的审批人表达式：取考核对象本人（员工自评）。 */
export const ASSESSMENT_ONLY_APPROVERS: ReadonlySet<ApproverExpression> = new Set(['assessment_employee']);
/** 只在离职交接申请上可用的审批人表达式。 */
export const HANDOVER_ONLY_APPROVERS: ReadonlySet<ApproverExpression> = new Set([
  'handover_work_owner',
  'handover_hr_admin',
  'handover_employee',
]);
/** 兜底处理人只对这两个取值生效（主取法取不到人时的备选，resolver.ts resolveCandidates）。 */
export const HANDOVER_FALLBACK_APPROVERS: ReadonlySet<ApproverExpression> = new Set([
  'handover_work_owner',
  'handover_hr_admin',
]);
export const HANDOVER_FALLBACK_LIMIT = 20;
export const OFFER_ONLY_APPROVERS: ReadonlySet<ApproverExpression> = new Set([
  'offer_department_head',
  'initiator_direct_manager',
  'approval_subject_first_level_org_head',
]);

/**
 * 组织调整审批的审批人白名单（R2-T08 §4.2）：申请单不是员工任职记录，流程主体与任职记录类取值取不到人，只开放这几项；
 * 两个“审批主体组织”取值只用于组织调整，不改其他业务的审批行为。
 */
export const ORG_ADJUSTMENT_APPROVERS: ReadonlySet<ApproverExpression> = new Set([
  'owner',
  'approval_subject_org_hrbp',
  'approval_subject_org_head',
]);
export const ORG_ADJUSTMENT_ONLY_APPROVERS: ReadonlySet<ApproverExpression> = new Set([
  'approval_subject_org_hrbp',
  'approval_subject_org_head',
]);

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
   * 拒绝本人。DEC-318 K-37 起是节点开关；DEC-329④ 起新建节点缺省关闭（未给出即关闭）。输入边界、加载与预置都显式给值
   * （F-048 设计 §3.2）；预置按业务敏感度取值（DEC-332①，§3.3）。
   */
  readonly avoidSelf?: boolean;
  /**
   * 多主体回避（F-048，DEC-329①）：节点审批人命中实例冻结的主体集合时，按 avoidSubjectsResult 自动处理。缺省关闭（照原站
   * isSameExpressionSkip）。F-048 PR-1 阶段定义校验拒绝开启，运行判定随 PR-2 接入时放开（设计 §14，R3-01）。
   */
  readonly avoidSubjects?: boolean;
  /** 发起人撤回（原站 isRevoke，DEC-318 K-39）：缺省开启（原有流程不变），IDP 预置流程关闭。 */
  readonly revoke?: boolean;
  /**
   * 驳回到上一步（原站 isRejectToPrevious，DEC-318 K-39）：回到上一个节点重新办理，重新提交后按正常顺序往后走
   * （isResubmitThisActivity = false）。缺省关闭；单人节点、非第一个节点才可用。
   */
  readonly rejectToPrevious?: boolean;
  /** 审批人跳转（原站节点系统动作“跳转”，DEC-318 K-39）：跳到本流程的其他节点。缺省关闭。 */
  readonly jump?: boolean;
}

/** 发起人能否在该节点撤回：未给出即开启。 */
export const revokeAllowed = (node: { readonly actions?: Pick<NodeActions, 'revoke'> }) =>
  node.actions?.revoke !== false;
/** 驳回到上一步：显式开启才可用。 */
export const rejectToPreviousAllowed = (node: { readonly actions?: Pick<NodeActions, 'rejectToPrevious'> }) =>
  node.actions?.rejectToPrevious === true;
/** 审批人跳转：显式开启才可用。 */
export const jumpAllowed = (node: { readonly actions?: Pick<NodeActions, 'jump'> }) => node.actions?.jump === true;

/** 节点是否自审回避：显式开启才回避（DEC-329④，新建节点缺省关闭）。 */
export function avoidsSelf(node: { readonly actions?: Pick<NodeActions, 'avoidSelf'> }): boolean {
  return node.actions?.avoidSelf === true;
}

/** 节点是否多主体回避：显式开启才回避（F-048，DEC-329①）。 */
export function avoidsSubjects(node: { readonly actions?: Pick<NodeActions, 'avoidSubjects'> }): boolean {
  return node.actions?.avoidSubjects === true;
}

/**
 * 多主体回避命中后的动作（DEC-331⑤，规格 14 §11.6）：契约预留跳过 / 同意 / 不同意 / 自定义出口动作；取证（Q-M0-138）前
 * 只启用「跳过」（DEC-329①），其余取值的启用条件见 F-048 设计 §3.1。
 */
export type AvoidSubjectsResult = 'skip' | 'approve' | 'disagree' | `exit:${string}`;
export const ENABLED_AVOID_SUBJECTS_RESULTS: readonly AvoidSubjectsResult[] = ['skip'];
export const DEFAULT_AVOID_SUBJECTS_RESULT: AvoidSubjectsResult = 'skip';

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
  /** 多主体回避命中后的动作（DEC-331⑤）；缺省「跳过」。 */
  readonly avoidSubjectsResult?: AvoidSubjectsResult;
  /** 出口动作（DEC-144）；缺省只有「同意」（DEFAULT_EXITS）。 */
  readonly exits?: readonly NodeExit[];
  /**
   * 兜底处理人（R2 BE-8b2，DEC-663，对应原站公共变量“离职交接流程-工作交接 / -其他事项交接”）：用户 ID 列表，可多人、可为空（缺省空）。
   * 只用于离职交接申请的会签交接节点：主取法（交接人 → 直线经理 / 人事管理员）取不到人时，改派其中具备审批资格的人。
   */
  readonly fallbackUserIds?: readonly string[];
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
 * talent_review：盘点结果审批（R3-T04 C-08）：PR-A 登记类型与预置流程，发起入口与运行时适配器随 PR-D 接入（集合审批）。
 * part_time：兼职申请（BE-7，R2-T05 §1.4 / §1.5）：PT-1 登记类型与预置流程，适配器为占位，PT-4a 接入兼职申请对象。
 * probation_assessment：试用中考核 / 转正考核（R2 BE-15b1，29 PB-R3）：业务单 = 考核记录，审批流 员工自评 → 经理评价。
 * org_adjustment：组织调整申请（R2-T08 BE-10a，DEC-526②）：业务单 = 组织调整申请单（独立对象，不再挂任职适配器），BE-10a 为占位。
 * retirement_intention：意向退休日期申请（R2-T04 5d2，设计 §11）：业务单 = 意向申请，审批通过只记录、不写人事字段（A-6）。
 * exit_handover：离职交接申请（R2 BE-8b2，B64）：业务单 = 交接申请，离职申请审批通过后系统代发，四节点，通过不改离职状态。
 */
export type ApprovalAdapterKind =
  | 'employment'
  | 'personnel_change'
  | 'employee_info'
  | 'contract'
  | 'idp'
  | 'talent_review'
  | 'part_time'
  | 'offer'
  | 'offer_batch'
  | 'probation_assessment'
  | 'org_adjustment'
  | 'retirement_intention'
  | 'exit_handover';
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

/** 离职流程匹配多一个输入：发起方式（hr / self / manager，R2-T03 §4B）。 */
const LEAVE_CONDITION_FIELDS: readonly ConditionField[] = [
  ...EMPLOYMENT_CONDITION_FIELDS,
  { path: 'business.initiation', label: '发起方式', kind: 'text' },
];

/**
 * 兼职三类申请的发起条件字段（R2-T05 §1.5）：兼职部门取申请 / 目标兼职记录的部门，主职部门取员工当前主职。
 * business.kind 是申请类型（add / extend / end），取值由 PT-4a 的适配器快照给出。
 */
const PART_TIME_CONDITION_FIELDS: readonly ConditionField[] = [
  { path: 'processCode', label: '流程编码', kind: 'text' },
  { path: 'business.kind', label: '申请类型', kind: 'text' },
  { path: 'employee.code', label: '兼职人员 - 工号', kind: 'text' },
  { path: 'employee.name', label: '兼职人员 - 姓名', kind: 'text' },
  { path: 'record.departmentId', label: '兼职部门', kind: 'org' },
  { path: 'employee.departmentId', label: '主职部门', kind: 'org' },
];

/**
 * 兼职三类申请（原站 ParttimeJobApproval，`14` §11.1:374）。字段权限沿用任职记录对象（PT-R4：申请字段编码 = 任职记录
 * 字段编码），审批中编辑开放（结束兼职预置“编辑并同意”，§4.5）。
 */
const partTimeType = (code: string, name: string, defaultProcessCode: string) =>
  ({
    code,
    name,
    objectCode: MODULE_OBJECTS.employmentRecord.code,
    adapter: 'part_time',
    defaultProcessCode,
    conditionFields: PART_TIME_CONDITION_FIELDS,
    formFields: employmentFormFields,
    readonlyFields: PROFILE_FORM_FIELDS,
    approvalEdit: true,
  }) as const satisfies ApprovalTypeDefinition;

const employmentType = (
  code: string,
  name: string,
  defaultProcessCode: string | null = null,
  conditionFields: readonly ConditionField[] = EMPLOYMENT_CONDITION_FIELDS,
) =>
  ({
    code,
    name,
    objectCode: MODULE_OBJECTS.employmentRecord.code,
    adapter: 'employment',
    defaultProcessCode,
    conditionFields,
    formFields: employmentFormFields,
    readonlyFields: PROFILE_FORM_FIELDS,
    approvalEdit: true,
  }) as const satisfies ApprovalTypeDefinition;

/**
 * 审批类型目录（`14` §11.1，原站 88 个类型中首版涉及的任职记录类型 + 员工信息类型）。原站没有“重聘”审批类型：
 * 重聘入职、退休返聘是「入职」的异动类型（`07` §2），走入职审批（approvalTypeOfBusiness）。
 * 原站「组织调整」审批类型挂在组织调整申请对象上（`33`），复刻为独立类型 ORG_ADJUSTMENT_TYPE（R2-T08）；任职记录上的组织调整
 * 异动（改组织名称 / 上级的任职联动）没有对应的审批流程。
 */
/**
 * Offer 审批（BE-14a3）：表单字段为 Offer 字段集，按 Offer 对象字段权限披露。原站单个 Offer 审批的标准编码与节点未取证，
 * 不带标准编码（预置为本类型兜底流程，DEC-018）。审批中编辑首版不开（DEC-105 同口径，改内容请驳回后在 Offer 上修改）。
 */
const OFFER_TYPE = {
  code: 'offer',
  name: 'Offer审批',
  objectCode: OFFER_OBJECT,
  adapter: 'offer',
  defaultProcessCode: null,
  conditionFields: [
    { path: 'processCode', label: '流程编码', kind: 'text' },
    { path: 'offer.offerType', label: 'Offer类型', kind: 'text' },
    { path: 'offer.departmentId', label: '录用部门', kind: 'org' },
  ],
  formFields: ['offerType', ...OFFER_FIELDS],
  readonlyFields: [],
  approvalEdit: false,
} as const satisfies ApprovalTypeDefinition;

/** Offer 批量审批（OF-R15，DEC-532⑦）：一单含多份 Offer 子表，按批量单对象的字段权限披露。 */
const OFFER_BATCH_TYPE = {
  code: 'offer_batch',
  name: 'Offer批量审批',
  objectCode: OFFER_BATCH_OBJECT,
  adapter: 'offer_batch',
  defaultProcessCode: OFFER_BATCH_PROCESS_CODE,
  conditionFields: [
    { path: 'processCode', label: '流程编码', kind: 'text' },
    { path: 'batch.approvalSubjectOrgId', label: '审批主体组织', kind: 'org' },
  ],
  formFields: OFFER_BATCH_FIELDS,
  readonlyFields: [],
  approvalEdit: false,
} as const satisfies ApprovalTypeDefinition;

/**
 * 试用期考核两类审批（BE-15b1，29 PB-R3）：业务单 = 考核记录，字段权限按考核对象判断；表单即考核字段。原站标准流程编码
 * 未取证，不带标准编码（预置为本类型兜底流程，DEC-018）。审批中编辑开放（员工自评 / 经理评价节点“同意按钮关联编辑”）。
 */
const assessmentType = (code: 'probation_assessment' | 'regularization_assessment', name: string) =>
  ({
    code,
    name,
    objectCode: PROBATION_ASSESSMENT_OBJECT,
    adapter: 'probation_assessment',
    defaultProcessCode: null,
    conditionFields: [
      { path: 'processCode', label: '流程编码', kind: 'text' },
      { path: 'employee.code', label: '考核对象 - 工号', kind: 'text' },
      { path: 'employee.name', label: '考核对象 - 姓名', kind: 'text' },
      { path: 'employee.departmentId', label: '考核对象 - 主职部门', kind: 'org' },
    ],
    formFields: ASSESSMENT_FORM_FIELDS,
    readonlyFields: [],
    approvalEdit: true,
  }) as const satisfies ApprovalTypeDefinition;

/**
 * 组织调整审批（R2-T08 §4.1，DEC-526②）：业务单 = 组织调整申请单，字段权限按 OrgAdjustment 对象（编码见
 * ORG_ADJUSTMENT_OBJECT_CODE，待 F-273 取证），表单即 §4.5 的静态命名空间字段；审批主体组织决定审批人（OA-R1）。
 */
const ORG_ADJUSTMENT_TYPE = {
  code: 'org_adjustment',
  name: '组织调整',
  objectCode: ORG_ADJUSTMENT_OBJECT_CODE,
  adapter: 'org_adjustment',
  defaultProcessCode: ORG_ADJUSTMENT_PROCESS_CODE,
  conditionFields: [
    { path: 'processCode', label: '流程编码', kind: 'text' },
    { path: 'adjustment.approvalSubjectOrgId', label: '审批主体组织', kind: 'org' },
  ],
  formFields: ORG_ADJUSTMENT_FORM_FIELDS,
  readonlyFields: [],
  approvalEdit: true,
} as const satisfies ApprovalTypeDefinition;

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
  leave: employmentType('leave', '离职', 'DimissionProcessNew', LEAVE_CONDITION_FIELDS),
  regularization: employmentType('regularization', '转正', 'ProbationProcessNew'),
  intern_regularization: employmentType('intern_regularization', '实习转正', 'TraineeEntryProcess'),
  hire: employmentType('hire', '入职', 'EntryProcessNew'),
  // R2-T04 §3.4：退休与离职同条件字段（含发起方式）；表单多带退休类型 / 是否返聘 / 预计退休日期（只读带出）
  retirement: {
    ...employmentType('retirement', '退休', 'RetireProcess', LEAVE_CONDITION_FIELDS),
    formFields: [...employmentFormFields, ...RETIREMENT_REQUEST_FIELDS],
  },
  org_adjustment: ORG_ADJUSTMENT_TYPE,
  // R2-T04 5d2 意向退休日期申请（设计 §11.2）：业务单是独立申请表，授权复用任职记录对象；原站类型编码 10000558 / 对象
  // TenantBase.FlexibleRetireApproval / 流程 IntendedRetireProcess（未发布，A-19）不冒充，defaultProcessCode = null + 本类型兜底预置
  retirement_intention: {
    code: 'retirement_intention',
    name: '意向退休日期申请',
    objectCode: MODULE_OBJECTS.employmentRecord.code,
    adapter: 'retirement_intention',
    defaultProcessCode: null,
    conditionFields: EMPLOYMENT_CONDITION_FIELDS,
    formFields: RETIREMENT_INTENTION_FORM_FIELDS,
    readonlyFields: RETIREMENT_INTENTION_SNAPSHOT_FIELDS,
    approvalEdit: false,
  },
  // R2 BE-8b2 离职交接申请：业务单是独立交接申请表，授权复用任职记录对象；原站流程编码未取证，defaultProcessCode = null + 本类型兜底预置。
  // 表单不带字段（审批人只办事项，事项在交接申请详情里读写），所以没有盲审字段
  exit_handover: {
    code: 'exit_handover',
    name: '离职交接申请',
    objectCode: MODULE_OBJECTS.employmentRecord.code,
    adapter: 'exit_handover',
    defaultProcessCode: null,
    conditionFields: EMPLOYMENT_CONDITION_FIELDS,
    formFields: [],
    readonlyFields: [],
    approvalEdit: false,
  },
  // BE-7 兼职（R2-T05 §1.5）：PT-1 只登记类型与预置，申请对象与发起入口随 PT-4a / PT-4b 接入
  part_time_add: partTimeType('part_time_add', '兼职', 'AddParttimeJobProcess'),
  part_time_extend: partTimeType('part_time_extend', '延长兼职', 'ExtendParttimeJobProcess'),
  part_time_end: partTimeType('part_time_end', '结束兼职', 'EndParttimeJobProcess'),
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
  // R3-T04 设计 §3.3（N12）：集合审批，一单涵盖多个被盘点人；审批中编辑开放校准后字段随 PR-D 接入后再开
  talent_review_result: {
    code: 'talent_review_result',
    name: '盘点结果审批',
    objectCode: TALENT_REVIEW_OBJECTS.resultApproval.code,
    adapter: 'talent_review',
    defaultProcessCode: null,
    conditionFields: [],
    formFields: [],
    readonlyFields: [],
    approvalEdit: false,
  },
  offer: OFFER_TYPE,
  offer_batch: OFFER_BATCH_TYPE,
  probation_assessment: assessmentType('probation_assessment', '试用中考核'),
  regularization_assessment: assessmentType('regularization_assessment', '转正考核'),
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
