/**
 * 流程定义校验：保存草稿时做结构校验；发布时再做 DEC-018 / DEC-054 规则校验（REQ-APV-001 R4/R5、REQ-APV-002 R6）。
 */
import { conditionViolations } from './conditions.js';
import { transitionRuleViolations } from './countersign.js';
import { HANDOVER_NODE_KEYS } from '../employment/exit-handover.js';
import {
  approverExpressionsOf,
  ASSESSMENT_ONLY_APPROVERS,
  avoidsSubjects,
  ENABLED_AVOID_SUBJECTS_RESULTS,
  hasExit,
  HANDOVER_FALLBACK_APPROVERS,
  HANDOVER_FALLBACK_LIMIT,
  HANDOVER_ONLY_APPROVERS,
  IDP_ONLY_APPROVERS,
  isCountersign,
  OFFER_APPROVERS,
  OFFER_ONLY_APPROVERS,
  nodeExits,
  type ApprovalNode,
  type ApprovalTypeDefinition,
  type ProcessDefinition,
} from './types.js';

export const MAX_NODES = 50;
const NODE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CUSTOM_FIELD = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DefinitionViolation {
  readonly reason: string;
  readonly message: string;
}

export function definitionViolations(definition: ProcessDefinition, type: ApprovalTypeDefinition): string[] {
  const violations = conditionViolations(definition.conditions, type.conditionFields);
  if (!definition.name.trim()) violations.push('流程名称不能为空');
  if (definition.nodes.length > MAX_NODES) violations.push(`节点最多 ${MAX_NODES} 个`);
  const keys = new Set<string>();
  const formFields = new Set(type.formFields);
  for (const node of definition.nodes) {
    if (!NODE_KEY.test(node.key) || keys.has(node.key)) violations.push(`节点编码 ${node.key} 不合法或重复`);
    keys.add(node.key);
    if (!node.name.trim()) violations.push(`节点 ${node.key} 名称不能为空`);
    // 任职类审批的节点表单可配置租户自定义任职字段（权限编码 custom:<id>，清单 3）；兼职申请同样带任职自定义字段
    // （R2-T05 §1.1 / §1.6，如租户自建的“兼职是否占人头”）。
    const known = (field: string) =>
      formFields.has(field) ||
      ((type.adapter === 'employment' || type.adapter === 'part_time') && CUSTOM_FIELD.test(field));
    const unknown = node.formFields.filter((field) => !known(field));
    if (unknown.length) violations.push(`节点 ${node.key} 表单字段不在对象目录内：${unknown.join('、')}`);
    const notOnForm = node.editableFields.filter((field) => !node.formFields.includes(field));
    if (notOnForm.length) violations.push(`节点 ${node.key} 可编辑字段必须在节点表单上：${notOnForm.join('、')}`);
    const readonly = node.editableFields.filter((field) => type.readonlyFields.includes(field));
    if (readonly.length) violations.push(`节点 ${node.key} 的只读带出字段不能编辑：${readonly.join('、')}`);
    if ((node.editMode === 'none') !== (node.editableFields.length === 0)) {
      violations.push(`节点 ${node.key} 的审批中编辑形态与可编辑字段不一致`);
    }
    if (!type.approvalEdit && node.editMode !== 'none') {
      violations.push(`节点 ${node.key}：${type.name}审批不支持审批中编辑（DEC-105）`);
    }
    violations.push(...nodeShapeViolations(node));
    const idpOnly = approverExpressionsOf(node).filter((expression) => IDP_ONLY_APPROVERS.has(expression));
    if (type.adapter !== 'idp' && idpOnly.length) {
      violations.push(`节点 ${node.key} 的审批人“发展计划 - 员工本人 / 指导人”只能用于发展计划审批（K-09）`);
    }
    const assessmentOnly = approverExpressionsOf(node).filter((expression) =>
      ASSESSMENT_ONLY_APPROVERS.has(expression),
    );
    if (type.adapter !== 'probation_assessment' && assessmentOnly.length) {
      violations.push(`节点 ${node.key} 的审批人“考核 - 考核对象本人”只能用于试用中考核 / 转正考核审批`);
    }
    const handoverOnly = approverExpressionsOf(node).filter((expression) => HANDOVER_ONLY_APPROVERS.has(expression));
    if (type.adapter !== 'exit_handover' && handoverOnly.length) {
      violations.push(`节点 ${node.key} 的审批人“离职交接”类取值只能用于离职交接申请审批`);
    }
    violations.push(...fallbackViolations(node, type));
    const emptyPolicy = emptyApproverPolicyViolation(node, type);
    if (emptyPolicy) violations.push(emptyPolicy);
    const offerViolation = offerApproverViolation(node, type);
    if (offerViolation) violations.push(offerViolation);
  }
  return violations;
}

/** F-316 / DEC-678：按交接节点校验三选一，不把自动同意开放给其他审批业务。 */
export function emptyApproverPolicyViolation(node: ApprovalNode, type: ApprovalTypeDefinition): string | null {
  const policy = node.emptyApproverPolicy;
  if (policy === undefined) return null;
  const work = node.key === HANDOVER_NODE_KEYS.work;
  const other = node.key === HANDOVER_NODE_KEYS.other;
  if (type.adapter !== 'exit_handover' || !isCountersign(node) || (!work && !other))
    return `节点 ${node.key} 的空审批人处理方式只能配置在离职交接的两个会签节点上`;
  const allowed = work ? ['stop', 'auto_approve', 'specified'] : ['exception_admin', 'auto_approve', 'specified'];
  if (!allowed.includes(policy)) return `节点 ${node.key} 的空审批人处理方式不合法`;
  if (policy === 'auto_approve' && !hasExit(node, 'approve')) return `节点 ${node.key} 配置自动同意时必须有同意出口`;
  return null;
}

/** DEC-663：兜底处理人只配在离职交接申请的会签交接节点上，且不重复、有上限。 */
function fallbackViolations(node: ApprovalNode, type: ApprovalTypeDefinition): string[] {
  const ids = node.fallbackUserIds ?? [];
  if (!ids.length) return [];
  const supported =
    type.adapter === 'exit_handover' &&
    isCountersign(node) &&
    approverExpressionsOf(node).some((expression) => HANDOVER_FALLBACK_APPROVERS.has(expression));
  if (!supported) return [`节点 ${node.key} 的兜底处理人只能配置在离职交接申请的会签交接节点上`];
  const violations: string[] = [];
  if (ids.length > HANDOVER_FALLBACK_LIMIT)
    violations.push(`节点 ${node.key} 的兜底处理人最多 ${HANDOVER_FALLBACK_LIMIT} 人`);
  if (new Set(ids).size !== ids.length) violations.push(`节点 ${node.key} 的兜底处理人重复`);
  return violations;
}

/** BE-14a3：Offer 两类审批只用白名单取值（OFFER_APPROVERS）；Offer 专用取值不用于其他类型。 */
function offerApproverViolation(node: ApprovalNode, type: ApprovalTypeDefinition): string | null {
  const expressions = approverExpressionsOf(node);
  const allowed = type.adapter === 'offer' || type.adapter === 'offer_batch' ? OFFER_APPROVERS[type.adapter] : null;
  const wrong = allowed
    ? expressions.filter((expression) => !allowed.has(expression))
    : expressions.filter((expression) => OFFER_ONLY_APPROVERS.has(expression));
  return wrong.length ? `节点 ${node.key} 的审批人 ${wrong.join('、')} 不能用于${type.name}审批` : null;
}

/** F-003：出口动作与会签节点的结构（审批人逐人解析，流转规则见 DEC-144）。 */
function nodeShapeViolations(node: ApprovalNode): string[] {
  const violations: string[] = [];
  const exits = nodeExits(node);
  if (!exits.length) violations.push(`节点 ${node.key} 至少需要一个出口动作`);
  if (new Set(exits).size !== exits.length) violations.push(`节点 ${node.key} 的出口动作重复`);
  if (!isCountersign(node)) return violations;
  if (!node.approvers.length) violations.push(`会签节点 ${node.key} 至少需要一个审批人`);
  if (new Set(node.approvers).size !== node.approvers.length) violations.push(`会签节点 ${node.key} 的审批人重复`);
  // DEC-106：自动处理的「跳过」仅单人审批节点可选（`14` §11.6），会签节点只能自动「同意」。
  if (node.sameAssigneeResult === 'skip' || node.historySameAssigneeResult === 'skip') {
    violations.push(`会签节点 ${node.key} 的相同 / 历史相同审批人自动处理结果只能为「同意」（DEC-106）`);
  }
  violations.push(...transitionRuleViolations(node));
  return violations;
}

/**
 * 发布校验：发起条件为空须显式兜底（DEC-018）；异常管理员必填（DEC-054）；至少一个审批节点；节点勾选加签、或开启
 * 相同 / 历史相同审批人自动处理时，必须有「同意」出口动作（`14` §11.4 CustomerKB 109710739，§11.6 自动处理沿同意线走）。
 */
export function publishViolations(definition: ProcessDefinition): DefinitionViolation[] {
  const violations: DefinitionViolation[] = definition.nodes.flatMap(avoidSubjectsViolations);
  if (!definition.conditions.items.length && !definition.isFallback) {
    violations.push({
      reason: 'APPROVAL_CONDITION_REQUIRED',
      message: '发起条件为空的流程只能在声明为本业务类型兜底流程时发布，请补充发起条件',
    });
  }
  if (!definition.exceptionAdminUserId) {
    violations.push({ reason: 'APPROVAL_EXCEPTION_ADMIN_REQUIRED', message: '流程必须配置异常管理员才能发布' });
  }
  if (!definition.nodes.length)
    violations.push({ reason: 'APPROVAL_NODES_REQUIRED', message: '流程至少需要一个审批节点' });
  for (const node of definition.nodes.filter((candidate) => !hasExit(candidate, 'approve'))) {
    if (node.actions.addSign) {
      // 提示照搬原站（CustomerKB 109710739“勾选加签的XXX节点必须配置同意出口线”）。
      const message = `勾选加签的${node.name}节点必须配置同意出口线`;
      violations.push({ reason: 'APPROVAL_ADD_SIGN_APPROVE_EXIT_REQUIRED', message });
    }
    if (node.sameAssigneeSkip || node.historySameAssigneeSkip) {
      const message = `开启相同 / 历史相同审批人自动处理的${node.name}节点必须配置同意出口线`;
      violations.push({ reason: 'APPROVAL_AUTO_APPROVE_EXIT_REQUIRED', message });
    }
  }
  return violations;
}

/**
 * F-048 多主体回避开关的定义校验（设计 §3.1、§14）。保存、草稿与发布共用。
 * - 与 DEC-106 的“跳过”相同：只有单人审批节点、且有「同意」出口时可开启（会签节点是否可用待 Q-M0-138）；
 * - DEC-331⑤：命中动作只启用「跳过」，其余预留取值（同意 / 不同意 / 自定义出口）待 Q-M0-138 取证后另行放开。
 */
export function avoidSubjectsViolations(node: ApprovalNode): DefinitionViolation[] {
  const violations: DefinitionViolation[] = [];
  if (avoidsSubjects(node) && (isCountersign(node) || !hasExit(node, 'approve'))) {
    violations.push({
      reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED',
      message: `节点 ${node.name}：多主体回避只能用于有「同意」出口的单人审批节点`,
    });
  }
  const result = node.avoidSubjectsResult;
  if (result !== undefined && !ENABLED_AVOID_SUBJECTS_RESULTS.includes(result)) {
    violations.push({
      reason: 'APPROVAL_AVOID_SUBJECTS_RESULT_UNSUPPORTED',
      message: `节点 ${node.name}：多主体回避命中后目前只支持「跳过」`,
    });
  }
  return violations;
}
