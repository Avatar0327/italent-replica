/** 流程定义的请求体校验：只接受 JSON 白名单结构，再交给领域校验（definitionViolations）。 */
import {
  APPROVER_EXPRESSIONS,
  CONDITION_OPERATORS,
  definitionViolations,
  EDIT_MODES,
  isApprovalType,
  MESSAGE_CHANNELS,
  MESSAGE_RECIPIENTS,
  MESSAGE_TRIGGERS,
  NO_ASSIGNEE_POLICIES,
  REJECT_RESUBMIT_MODES,
  APPROVAL_TYPES,
  type ApprovalTypeCode,
  type ProcessDefinition,
} from '@italent/domain';
import { z } from 'zod';
import { approvalError } from './context.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const codeList = z.array(z.string().min(1).max(100)).max(200);

const messageRule = z.strictObject({
  trigger: z.enum(MESSAGE_TRIGGERS),
  channels: z.array(z.enum(MESSAGE_CHANNELS)).min(1).max(3),
  template: text(200),
  recipient: z.enum(MESSAGE_RECIPIENTS),
});

const node = z.strictObject({
  key: text(40),
  name: text(100).optional(),
  approver: z.enum(APPROVER_EXPRESSIONS),
  noAssignee: z.enum(NO_ASSIGNEE_POLICIES).default('exception_admin'),
  sameAssigneeSkip: z.boolean().default(false),
  historySameAssigneeSkip: z.boolean().default(false),
  formFields: codeList.default([]),
  editableFields: codeList.default([]),
  editMode: z.enum(EDIT_MODES).default('none'),
  actions: z
    .strictObject({
      transfer: z.boolean().default(false),
      addSign: z.boolean().default(false),
      urge: z.boolean().default(true),
    })
    .default({ transfer: false, addSign: false, urge: true }),
  rejectCommentRequired: z.boolean().default(false),
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
  exceptionAdminUserId: z.uuid().nullable().default(null),
  urgeEnabled: z.boolean().default(true),
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

/** 结构化后的定义；值缺省补 null，名称缺省取节点编码。 */
export function toDefinition(input: DefinitionInput, type: ApprovalTypeCode): ProcessDefinition {
  const definition: ProcessDefinition = {
    name: input.name,
    groupName: input.groupName ?? null,
    description: input.description ?? null,
    priority: input.priority,
    isFallback: input.isFallback,
    exceptionAdminUserId: input.exceptionAdminUserId,
    urgeEnabled: input.urgeEnabled,
    conditions: {
      expression: input.conditions.expression.trim(),
      items: input.conditions.items.map((item) => ({ ...item, value: item.value ?? null })),
    },
    nodes: input.nodes.map((n) => ({ ...n, name: n.name ?? n.key })),
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
