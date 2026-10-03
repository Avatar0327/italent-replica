/**
 * 流程仿真（DEC-036，`14` §9.3）：虚拟数据 + 真实组织 / 人员数据解析审批人；只读，不建实例、不发消息、不生成待办。
 * 按对象仿真同时给出原站规则（按实体、跨审批类型按优先级）与复刻规则（DEC-017）的命中流程。
 */
import type { Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  evaluateCondition,
  tenantLocalDate,
  type ApprovalTypeCode,
  type NodeDecision,
  type RoutingFacts,
} from '@italent/domain';
import { approvalError, type ApprovalContext } from './context.js';
import { loadProcess, type VersionView } from './definitions.js';
import { decide } from './engine.js';
import {
  candidates,
  conditionContext,
  evaluate,
  noProcessMessage,
  originalSiteMatch,
  replicaMatch,
} from './matching.js';
import { userOfPerson, type RoutingSubject } from './resolver.js';

export interface SimulationData {
  readonly values: Readonly<Record<string, unknown>>;
  readonly subjectEmployeeId?: string | null;
  readonly initiatorUserId?: string | null;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

function subjectOf(ctx: ApprovalContext, data: SimulationData): RoutingSubject {
  const values = data.values;
  return {
    tenantId: ctx.tenantId,
    asOf: tenantLocalDate(ctx.now, ctx.timezone),
    initiatorUserId: data.initiatorUserId ?? ctx.userId,
    latestDepartmentId: text(values['before.departmentId']) ?? text(values['employee.departmentId']),
    recordDepartmentId: text(values['record.departmentId']) ?? text(values['employee.departmentId']),
  };
}

function describe(decision: NodeDecision, hasAdmin: boolean) {
  if (decision.kind === 'first_node_empty') {
    return {
      status: 'exception',
      approverUserId: null,
      resolution: 'first_node_empty',
      message: `${decision.reason}，提交将报错`,
    };
  }
  if (decision.kind === 'auto') {
    const warning = decision.outcome.startsWith('no_assignee');
    return {
      status: warning ? 'warning' : 'pass',
      approverUserId: decision.userId,
      resolution: decision.outcome,
      message: decision.reason,
    };
  }
  if (decision.origin === 'exception_admin') {
    const missing = hasAdmin ? '' : '（流程未配置异常管理员，不能发布）';
    return {
      status: 'exception',
      approverUserId: hasAdmin ? decision.userId : null,
      resolution: 'exception_admin',
      message: decision.reason + missing,
    };
  }
  const status = decision.origin === 'self_skip_manager' ? 'warning' : 'pass';
  return { status, approverUserId: decision.userId, resolution: decision.origin, message: decision.reason };
}

/** 逐节点推演：假定每个节点由解析出的审批人同意，据此计算后续节点的相同 / 历史审批人与审批链。 */
async function simulateNodes(tx: Tx, ctx: ApprovalContext, version: VersionView, data: SimulationData) {
  const subject = subjectOf(ctx, data);
  const subjectEmployeeId = data.subjectEmployeeId ?? null;
  const subjectUserId = await userOfPerson(tx, ctx.tenantId, subjectEmployeeId);
  const approved: string[] = [];
  let previous: string | null = null;
  const results = [];
  for (const [index, node] of version.nodes.entries()) {
    const facts: RoutingFacts = {
      isFirstNode: index === 0,
      initiatorUserId: subject.initiatorUserId,
      subjectEmployeeId,
      subjectUserId,
      exceptionAdminUserId: version.exceptionAdminUserId ?? '',
      previousApproverUserId: previous,
      approvedUserIds: approved,
      chainUserIds: approved,
    };
    const decision = await decide(tx, subject, node, facts);
    const outcome = describe(decision, version.exceptionAdminUserId !== null);
    previous = outcome.approverUserId;
    if (outcome.approverUserId) approved.push(outcome.approverUserId);
    const recipients = node.messageRules.map((rule) => ({
      trigger: rule.trigger,
      channels: rule.channels,
      template: rule.template,
      recipientUserId:
        rule.recipient === 'owner'
          ? subject.initiatorUserId
          : rule.recipient === 'assignee'
            ? outcome.approverUserId
            : subjectUserId,
    }));
    results.push({ key: node.key, name: node.name, formFields: node.formFields, messages: recipients, ...outcome });
  }
  return results;
}

export async function simulateProcess(
  tx: Tx,
  ctx: ApprovalContext,
  processId: string,
  request: { scope: 'published' | 'latest'; data: SimulationData },
) {
  const process = await loadProcess(tx, ctx.tenantId, processId);
  const version = request.scope === 'published' ? process.currentVersion : process.latestVersion;
  if (!version) throw approvalError('CONFLICT', 'APPROVAL_NOT_PUBLISHED', '流程尚无已发布版本');
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const context = await conditionContext(tx, ctx.tenantId, asOf, process.approvalType, request.data.values);
  const conditions = evaluateCondition(version.conditions, context);
  const nodes = await simulateNodes(tx, ctx, version, request.data);
  return {
    processId,
    versionNo: version.versionNo,
    versionStatus: version.status,
    conditions,
    nodes,
    startable: conditions.result && !nodes.some((node) => node.resolution === 'first_node_empty'),
    requiredInputs: APPROVAL_TYPES[process.approvalType].conditionFields.map((field) => field.path),
  };
}

export async function simulateByObject(
  tx: Tx,
  ctx: ApprovalContext,
  request: { approvalType: ApprovalTypeCode; scope: 'published' | 'latest'; data: SimulationData },
) {
  const type = APPROVAL_TYPES[request.approvalType];
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const list = await candidates(tx, ctx.tenantId, { objectCode: type.objectCode, scope: request.scope });
  const context = await conditionContext(tx, ctx.tenantId, asOf, request.approvalType, request.data.values);
  const evaluated = evaluate(list, context);
  const pick = (item: (typeof evaluated)[number] | null) =>
    item && {
      processId: item.processId,
      code: item.code,
      approvalType: item.approvalType,
      versionNo: item.version.versionNo,
    };
  const replica = replicaMatch(evaluated, request.approvalType);
  return {
    approvalType: request.approvalType,
    objectCode: type.objectCode,
    scope: request.scope,
    processes: evaluated.map((item) => ({
      processId: item.processId,
      code: item.code,
      approvalType: item.approvalType,
      versionNo: item.version.versionNo,
      versionStatus: item.version.status,
      priority: item.version.priority,
      isFallback: item.version.isFallback,
      matched: item.condition.result,
      expression: item.condition.expression,
      items: item.condition.items,
    })),
    originalSite: pick(originalSiteMatch(evaluated)),
    replica: pick(replica),
    replicaError: replica ? null : noProcessMessage(request.approvalType),
  };
}
