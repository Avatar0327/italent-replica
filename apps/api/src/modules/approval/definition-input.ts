/** 流程定义的请求体校验：只接受 JSON 白名单结构，再交给领域校验（definitionViolations）。 */
import {
  APPROVER_EXPRESSIONS,
  AUTO_RESULTS,
  CONDITION_OPERATORS,
  definitionViolations,
  EDIT_MODES,
  EXIT_RULE_KINDS,
  isApprovalType,
  MESSAGE_CHANNELS,
  MESSAGE_RECIPIENTS,
  MESSAGE_TRIGGERS,
  NO_ASSIGNEE_POLICIES,
  NODE_EXITS,
  NODE_KINDS,
  REJECT_RESUBMIT_MODES,
  TRANSITION_RULE_TYPES,
  URGE_MODES,
  APPROVAL_TYPES,
  type ApprovalNode,
  type ApprovalTypeCode,
  type ProcessDefinition,
} from '@italent/domain';
import { z } from 'zod';
import { approvalError, canonicalId } from './context.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const codeList = z.array(z.string().min(1).max(100)).max(200);

const messageRule = z.strictObject({
  trigger: z.enum(MESSAGE_TRIGGERS),
  channels: z.array(z.enum(MESSAGE_CHANNELS)).min(1).max(3),
  template: text(200),
  recipient: z.enum(MESSAGE_RECIPIENTS),
});

const exitRule = z.strictObject({ kind: z.enum(EXIT_RULE_KINDS), value: z.number().finite() });

/** DEC-144：会签流转规则；缺省为任一人同意即可（新会签节点默认），自定义审批方式按出口动作逐行给出条件。 */
const transitionRule = z.strictObject({
  type: z.enum(TRANSITION_RULE_TYPES),
  rules: z.strictObject({ approve: exitRule.optional(), disagree: exitRule.optional() }).optional(),
});

const node = z.strictObject({
  key: text(40),
  name: text(100).optional(),
  /** F-003：单人审批（缺省）/ 会签审批。 */
  kind: z.enum(NODE_KINDS).default('single'),
  /** 单人审批节点的审批人。 */
  approver: z.enum(APPROVER_EXPRESSIONS).optional(),
  /** 会签节点的审批人（逐人解析，表达式不重复）。 */
  approvers: z.array(z.enum(APPROVER_EXPRESSIONS)).max(APPROVER_EXPRESSIONS.length).optional(),
  transitionRule: transitionRule.optional(),
  /** 出口动作（DEC-144）：缺省只有「同意」。 */
  exits: z.array(z.enum(NODE_EXITS)).max(NODE_EXITS.length).default(['approve']),
  noAssignee: z.enum(NO_ASSIGNEE_POLICIES).default('exception_admin'),
  sameAssigneeSkip: z.boolean().default(false),
  historySameAssigneeSkip: z.boolean().default(false),
  sameAssigneeResult: z.enum(AUTO_RESULTS).default('approve'),
  historySameAssigneeResult: z.enum(AUTO_RESULTS).default('approve'),
  formFields: codeList.default([]),
  editableFields: codeList.default([]),
  editMode: z.enum(EDIT_MODES).default('none'),
  actions: z
    .strictObject({
      transfer: z.boolean().default(false),
      addSign: z.boolean().default(false),
      copySend: z.boolean().default(false),
      retrieve: z.boolean().default(false),
      /** 驳回（驳回到发起人）开关，缺省开启（R1-T07 起的节点一直可以驳回）。 */
      reject: z.boolean().default(true),
      urge: z.enum(URGE_MODES).default('inherit'),
      /** 自审回避（DEC-318 K-37）：缺省不给即开启，原有流程不变。 */
      avoidSelf: z.boolean().optional(),
    })
    .default({ transfer: false, addSign: false, copySend: false, retrieve: false, reject: true, urge: 'inherit' }),
  rejectCommentRequired: z.boolean().default(false),
  hideRecords: z.boolean().default(false),
  rejectResubmit: z.enum(REJECT_RESUBMIT_MODES).default('restart'),
  messageRules: z.array(messageRule).max(20).default([]),
});

const conditionItem = z.strictObject({
  no: z.number().int().min(1).max(999),
  field: text(100),
  operator: z.enum(CONDITION_OPERATORS),
  value: z
    .union([z.string().max(500), z.array(z.string().max(500)).max(200)])
    .nullable()
    .optional(),
});

export const definitionSchema = z.strictObject({
  name: text(100),
  groupName: optionalText(100),
  description: optionalText(1000),
  priority: z.number().int().min(-100000).max(100000).default(0),
  isFallback: z.boolean().default(false),
  exceptionAdminUserId: z.uuid().transform(canonicalId).nullable().default(null),
  urgeEnabled: z.boolean().default(true),
  hideRecordsFromInitiator: z.boolean().default(false),
  conditions: z
    .strictObject({ items: z.array(conditionItem).max(50), expression: z.string().max(500).default('') })
    .default({ items: [], expression: '' }),
  nodes: z.array(node).max(50),
});

export const createSchema = definitionSchema.extend({
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  approvalType: z.string(),
});

export type DefinitionInput = z.infer<typeof definitionSchema>;
type NodeInput = DefinitionInput['nodes'][number];

/** 单人节点只用 approver，会签节点只用 approvers 与流转规则（F-003）；缺了或混用都是结构错误。 */
function nodeTypeViolations(input: NodeInput): string[] {
  if (input.kind === 'countersign') {
    const violations = input.approver ? [`会签节点 ${input.key} 用审批人列表（approvers），不能设单个审批人`] : [];
    if (!input.approvers) violations.push(`会签节点 ${input.key} 必须配置审批人`);
    return violations;
  }
  const violations = input.approver ? [] : [`节点 ${input.key} 必须配置审批人`];
  if (input.approvers || input.transitionRule)
    violations.push(`单人审批节点 ${input.key} 不能配置会签审批人或流转规则`);
  return violations;
}

function toNode(input: NodeInput): ApprovalNode {
  const { kind, approver, approvers, transitionRule, name, ...common } = input;
  const base = { ...common, name: name ?? input.key };
  if (kind === 'countersign') {
    // DEC-144：新会签节点缺省为任一人同意即可。
    return { ...base, kind, approvers: approvers ?? [], transitionRule: transitionRule ?? { type: 'any' } };
  }
  return { ...base, kind, approver: approver! };
}

/** 结构化后的定义；值缺省补 null，名称缺省取节点编码，会签流转规则缺省为任一人同意即可（DEC-144）。 */
export function toDefinition(input: DefinitionInput, type: ApprovalTypeCode): ProcessDefinition {
  const shape = input.nodes.flatMap(nodeTypeViolations);
  if (shape.length) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_DEFINITION_INVALID', shape[0]!, { violations: shape });
  }
  const definition: ProcessDefinition = {
    name: input.name,
    groupName: input.groupName ?? null,
    description: input.description ?? null,
    priority: input.priority,
    isFallback: input.isFallback,
    exceptionAdminUserId: input.exceptionAdminUserId,
    urgeEnabled: input.urgeEnabled,
    hideRecordsFromInitiator: input.hideRecordsFromInitiator,
    conditions: {
      expression: input.conditions.expression.trim(),
      items: input.conditions.items.map((item) => ({ ...item, value: item.value ?? null })),
    },
    nodes: input.nodes.map(toNode),
  };
  const violations = definitionViolations(definition, APPROVAL_TYPES[type]);
  if (violations.length)
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_DEFINITION_INVALID', violations[0]!, { violations });
  return definition;
}

export function approvalTypeOf(value: string): ApprovalTypeCode {
  if (!isApprovalType(value)) throw approvalError('VALIDATION_FAILED', 'APPROVAL_TYPE_UNKNOWN', '审批类型不存在');
  return value;
}
