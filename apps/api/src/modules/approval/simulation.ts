/**
 * 流程仿真（DEC-036，`14` §9.3）：只用虚拟数据——审批人关系（表达式 → 账号）、直线经理、组织上下级都由仿真输入给出，
 * 不读取真实人员、组织负责人或账号绑定，只有仿真权限的人拿不到范围外的真实关系（PR #35 第二轮清单 7）。
 * 只读，不建实例、不发消息、不生成待办。按对象仿真同时给出原站规则（按实体、跨审批类型按优先级）与复刻规则
 * （DEC-017）的命中流程，并对复刻命中流程继续核算能否提交（X-17）。
 */
import type { Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  avoidSelfExceptionAdmin,
  decideNode,
  evaluateCondition,
  isSelf,
  type ApprovalNode,
  type ApprovalTypeCode,
  type ApproverExpression,
  type Candidate,
  type ConditionContext,
  type NodeDecision,
  type RoutingFacts,
} from '@italent/domain';
import { validIsoDate } from '../org/read-model.js';
import { approvalError, type ApprovalContext } from './context.js';
import { loadProcess, loadVersion, type VersionView } from './definitions.js';
import { candidates, evaluate, noProcessMessage, originalSiteMatch, replicaMatch } from './matching.js';

export interface SimulationData {
  readonly values: Readonly<Record<string, string | null>>;
  /** 虚拟审批人关系：表达式 → 账号；未给出即视为审批人为空。 */
  readonly relations?: Readonly<Partial<Record<ApproverExpression, string | null>>>;
  /** 虚拟直线经理：账号 → 经理账号（自审跳过、异常管理员回避用）。 */
  readonly managers?: Readonly<Record<string, string | null>>;
  /** 虚拟组织上下级：组织 → 行政祖先链（含自身），供“包含下级”条件核算。 */
  readonly orgAncestors?: Readonly<Record<string, readonly string[]>>;
  readonly initiatorUserId?: string | null;
  readonly subjectUserId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOBODY: Candidate = { personId: null, userId: null };

/** X-18：按条件字段类型校验输入（组织 / 引用须为标识，日期须为合法日期），不把虚拟值当主键查库。 */
function conditionContext(type: ApprovalTypeCode, data: SimulationData): ConditionContext {
  const fields = new Map(APPROVAL_TYPES[type].conditionFields.map((field) => [field.path, field.kind]));
  const orgAncestors: Record<string, readonly string[]> = {};
  for (const [path, value] of Object.entries(data.values)) {
    const kind = fields.get(path);
    const invalid =
      !kind ||
      (value !== null &&
        (((kind === 'org' || kind === 'reference') && !UUID.test(value)) || (kind === 'date' && !validIsoDate(value))));
    if (invalid) {
      throw approvalError('VALIDATION_FAILED', 'APPROVAL_SIMULATION_INPUT', `仿真输入 ${path} 不合法`, { field: path });
    }
    if (kind === 'org' && value) orgAncestors[value] = data.orgAncestors?.[value] ?? [value];
  }
  return { values: data.values, orgAncestors };
}

const managerOf = (data: SimulationData, candidate: Candidate): Candidate => ({
  personId: null,
  userId: (candidate.userId && data.managers?.[candidate.userId]) ?? null,
});

function decideVirtual(node: ApprovalNode, data: SimulationData, facts: RoutingFacts): NodeDecision {
  const userId = node.approver === 'owner' ? facts.initiatorUserId : (data.relations?.[node.approver] ?? null);
  const candidate: Candidate = userId ? { personId: null, userId } : NOBODY;
  const draft = decideNode(node, candidate, facts);
  if (draft.kind !== 'assign' || draft.selfSkippedUserId === null) return draft;
  return decideNode(node, candidate, facts, managerOf(data, candidate));
}

function describe(decision: NodeDecision, version: VersionView, data: SimulationData, facts: RoutingFacts) {
  if (decision.kind === 'first_node_empty') {
    return {
      status: 'exception',
      approverUserId: null,
      resolution: 'first_node_empty',
      message: `${decision.reason}，提交将报错`,
    };
  }
  if (decision.kind === 'auto') {
    return { status: 'pass', approverUserId: decision.userId, resolution: decision.outcome, message: decision.reason };
  }
  if (decision.origin === 'exception_admin') {
    if (!version.exceptionAdminUserId) {
      const message = `${decision.reason}（流程未配置异常管理员，不能发布）`;
      return { status: 'exception', approverUserId: null, resolution: 'exception_admin', message };
    }
    const admin: Candidate = { personId: null, userId: version.exceptionAdminUserId };
    const choice = avoidSelfExceptionAdmin(admin, facts, isSelf(admin, facts) ? managerOf(data, admin) : undefined);
    const approverUserId = choice.kind === 'assign' ? choice.userId : null;
    return { status: 'exception', approverUserId, resolution: 'exception_admin', message: decision.reason };
  }
  const status = decision.origin === 'self_skip_manager' ? 'warning' : 'pass';
  return { status, approverUserId: decision.userId, resolution: decision.origin, message: decision.reason };
}

/** 逐节点推演：假定每个节点由解析出的审批人同意，据此计算后续节点的相同 / 历史审批人与审批链。 */
function simulateNodes(ctx: ApprovalContext, version: VersionView, data: SimulationData) {
  const initiatorUserId = data.initiatorUserId ?? ctx.userId;
  const approved: string[] = [];
  let previous: string | null = null;
  return version.nodes.map((node, index) => {
    const facts: RoutingFacts = {
      isFirstNode: index === 0,
      initiatorUserId,
      subjectEmployeeId: null,
      subjectUserId: data.subjectUserId ?? null,
      exceptionAdminUserId: version.exceptionAdminUserId ?? '',
      previousApproverUserId: previous,
      approvedUserIds: approved,
      chainUserIds: approved,
    };
    const outcome = describe(decideVirtual(node, data, facts), version, data, facts);
    previous = outcome.approverUserId;
    if (outcome.approverUserId) approved.push(outcome.approverUserId);
    const messages = node.messageRules.map((rule) => ({
      trigger: rule.trigger,
      channels: rule.channels,
      template: rule.template,
      recipientUserId:
        rule.recipient === 'owner'
          ? initiatorUserId
          : rule.recipient === 'assignee'
            ? outcome.approverUserId
            : (data.subjectUserId ?? null),
    }));
    return { key: node.key, name: node.name, formFields: node.formFields, messages, ...outcome };
  });
}

const startable = (nodes: ReturnType<typeof simulateNodes>) =>
  !nodes.some((node) => node.resolution === 'first_node_empty');

export async function simulateProcess(
  tx: Tx,
  ctx: ApprovalContext,
  processId: string,
  request: { scope: 'published' | 'latest'; data: SimulationData },
) {
  const process = await loadProcess(tx, ctx.tenantId, processId);
  const version = request.scope === 'published' ? process.currentVersion : process.latestVersion;
  if (!version) throw approvalError('CONFLICT', 'APPROVAL_NOT_PUBLISHED', '流程尚无已发布版本');
  const conditions = evaluateCondition(version.conditions, conditionContext(process.approvalType, request.data));
  const nodes = simulateNodes(ctx, version, request.data);
  return {
    processId,
    versionNo: version.versionNo,
    versionStatus: version.status,
    conditions,
    nodes,
    startable: conditions.result && startable(nodes),
    requiredInputs: APPROVAL_TYPES[process.approvalType].conditionFields.map((field) => field.path),
  };
}

export async function simulateByObject(
  tx: Tx,
  ctx: ApprovalContext,
  request: { approvalType: ApprovalTypeCode; scope: 'published' | 'latest'; data: SimulationData },
) {
  const type = APPROVAL_TYPES[request.approvalType];
  const list = await candidates(tx, ctx.tenantId, { objectCode: type.objectCode, scope: request.scope });
  const evaluated = evaluate(list, conditionContext(request.approvalType, request.data));
  const pick = (item: (typeof evaluated)[number] | null) =>
    item && {
      processId: item.processId,
      code: item.code,
      approvalType: item.approvalType,
      versionNo: item.version.versionNo,
    };
  const replica = replicaMatch(evaluated, request.approvalType);
  // X-17：命中流程后继续无副作用地核算能否提交（首节点为空时提交会失败）。
  const nodes = replica
    ? simulateNodes(ctx, await loadVersion(tx, ctx.tenantId, replica.version.id), request.data)
    : [];
  const blocked = nodes.find((node) => node.resolution === 'first_node_empty');
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
    replicaStartable: replica !== null && !blocked,
    replicaError: replica ? (blocked?.message ?? null) : noProcessMessage(request.approvalType),
  };
}
