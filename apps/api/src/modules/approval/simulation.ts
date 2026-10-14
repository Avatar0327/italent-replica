/**
 * 流程仿真（DEC-036，`14` §9.3）：只用虚拟数据——审批人关系（表达式 → 账号）、直线经理、组织上下级都由仿真输入给出，
 * 不读取真实人员、组织负责人或账号绑定，只有仿真权限的人拿不到范围外的真实关系（PR #35 第二轮清单 7）。
 * 只读，不建实例、不发消息、不生成待办。按对象仿真同时给出原站规则（按实体、跨审批类型按优先级）与复刻规则
 * （DEC-017）的命中流程，并对复刻命中流程继续核算能否提交（X-17）。会签节点（F-003）逐人给出审批人与处理方式，
 * 并给出按出口动作生成的流转规则（DEC-144）。
 */
import type { Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  adminRecused,
  approverExpressionsOf,
  avoidSelfExceptionAdmin,
  decideNode,
  evaluateCondition,
  exitRulesOf,
  isCountersign,
  nodeExits,
  nodeKindOf,
  recusalFacts,
  submitBlockers,
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
  /** F-048：虚拟的主体账号集合 U(S)（多主体回避仿真，≤50）。 */
  readonly subjectUserIds?: readonly string[];
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

function candidateOf(expression: ApproverExpression, data: SimulationData, facts: RoutingFacts): string | null {
  return expression === 'owner' ? facts.initiatorUserId : (data.relations?.[expression] ?? null);
}

function decideVirtual(
  node: ApprovalNode,
  expression: ApproverExpression,
  data: SimulationData,
  facts: RoutingFacts,
): NodeDecision {
  const userId = candidateOf(expression, data, facts);
  // 仿真只有虚拟账号，没有人员：候选一律按账号比较
  const candidate: Candidate = userId ? { personId: null, userId, accountSource: true } : NOBODY;
  const draft = decideNode(node, candidate, facts);
  if (draft.kind !== 'assign' || draft.selfSkippedUserId === null) return draft;
  return decideNode(node, candidate, facts, managerOf(data, candidate));
}

function describe(decision: NodeDecision, version: VersionView, data: SimulationData, facts: RoutingFacts) {
  if (decision.kind === 'no_assignee') {
    return {
      status: 'exception',
      approverUserId: null,
      resolution: 'no_assignee',
      message: `${decision.reason}，推进到本节点将报错`,
    };
  }
  if (decision.kind === 'first_node_empty') {
    return {
      status: 'exception',
      approverUserId: null,
      resolution: 'first_node_empty',
      message: `${decision.reason}，提交将报错`,
    };
  }
  if (decision.kind === 'auto') {
    // DEC-106：自动「跳过」处理人记为系统，不计为该审批人的同意。
    const approverUserId = decision.result === 'skip' ? null : decision.userId;
    return {
      status: 'pass',
      approverUserId,
      resolution: decision.outcome,
      result: decision.result,
      message: decision.reason,
    };
  }
  if (decision.origin === 'exception_admin') {
    if (!version.exceptionAdminUserId) {
      const message = `${decision.reason}（流程未配置异常管理员，不能发布）`;
      return { status: 'exception', approverUserId: null, resolution: 'exception_admin', message };
    }
    const admin: Candidate = { personId: null, userId: version.exceptionAdminUserId };
    const choice = avoidSelfExceptionAdmin(
      admin,
      facts,
      adminRecused(admin, facts) ? managerOf(data, admin) : undefined,
    );
    const approverUserId = choice.kind === 'assign' ? choice.userId : null;
    return { status: 'exception', approverUserId, resolution: 'exception_admin', message: decision.reason };
  }
  const status = decision.origin === 'self_skip_manager' ? 'warning' : 'pass';
  return { status, approverUserId: decision.userId, resolution: decision.origin, message: decision.reason };
}

function virtualFacts(ctx: ApprovalContext, version: VersionView, data: SimulationData, index: number): RoutingFacts {
  return {
    ...recusalFacts({
      initiatorUserId: data.initiatorUserId ?? ctx.userId,
      primaryEmployeeId: null,
      primaryUserId: data.subjectUserId ?? null,
      subjectEmployeeIds: [],
      subjectUserIds: data.subjectUserIds ?? [],
    }),
    isFirstNode: index === 0,
    exceptionAdminUserId: version.exceptionAdminUserId ?? '',
    previousApproverUserIds: [],
    approvedUserIds: [],
    chainUserIds: [],
  };
}

/**
 * F13：与真实提交同一套预检（submitBlockers）——第一个节点没有审批人，或异常管理员本人回避后（按虚拟直线经理）
 * 无人接替，都不可提交。
 */
function preflight(ctx: ApprovalContext, version: VersionView, data: SimulationData) {
  const facts = virtualFacts(ctx, version, data, 0);
  const node = version.nodes[0];
  // 会签首节点逐人核验（F-003）：任一人为空即不可提交。
  const decisions = node
    ? approverExpressionsOf(node).map((expression) => decideVirtual(node, expression, data, facts))
    : [];
  const first = decisions.find((decision) => decision.kind === 'first_node_empty') ?? decisions[0];
  const admin: Candidate = version.exceptionAdminUserId
    ? { personId: null, userId: version.exceptionAdminUserId }
    : NOBODY;
  const choice = avoidSelfExceptionAdmin(admin, facts, adminRecused(admin, facts) ? managerOf(data, admin) : undefined);
  return submitBlockers(choice, first).map((blocker) => blocker.message);
}

type Outcome = ReturnType<typeof describe>;

/** 与真实提交一致（F-003）：两个表达式解析为同一人、或落到同一接手人时只算一席。 */
function simulatedSeats(
  node: ApprovalNode,
  expressions: readonly ApproverExpression[],
  version: VersionView,
  data: SimulationData,
  facts: RoutingFacts,
) {
  const seats: (Outcome & { expression: ApproverExpression })[] = [];
  const candidates = new Set<string>();
  for (const expression of expressions) {
    const candidate = candidateOf(expression, data, facts);
    if (candidate !== null && candidates.has(candidate)) continue;
    if (candidate !== null) candidates.add(candidate);
    const outcome = describe(decideVirtual(node, expression, data, facts), version, data, facts);
    if (outcome.approverUserId && seats.some((seat) => seat.approverUserId === outcome.approverUserId)) continue;
    seats.push({ expression, ...outcome });
  }
  return seats;
}
const STATUS_RANK: Readonly<Record<string, number>> = { pass: 0, warning: 1, exception: 2 };

/** 会签节点的汇总（F-003）：状态取逐人结果中最严重的，审批人逐人列在 approvers 中。 */
function countersignSummary(node: ApprovalNode, seats: readonly (Outcome & { expression: string })[]) {
  if (!isCountersign(node)) {
    const { expression: _expression, ...single } = seats[0]!;
    return single;
  }
  const status = seats.reduce(
    (worst, seat) => (STATUS_RANK[seat.status]! > STATUS_RANK[worst]! ? seat.status : worst),
    'pass',
  );
  const transitionRule = { type: node.transitionRule.type, rules: exitRulesOf(node.transitionRule, nodeExits(node)) };
  const message = `会签：${seats.length} 名审批人同时审批，按流转规则流转`;
  return { status, approverUserId: null, resolution: 'countersign', message, transitionRule };
}

/**
 * 逐节点推演：假定每个节点由解析出的审批人同意（会签节点假定全部审批人同意），据此计算后续节点的相同 / 历史审批人与
 * 审批链。DEC-114：“与上一节点相同”比较上一节点解析出的候选人（跳过的节点也有候选人；会签节点有多个）。
 */
function simulateNodes(ctx: ApprovalContext, version: VersionView, data: SimulationData) {
  const initiatorUserId = data.initiatorUserId ?? ctx.userId;
  const approved: string[] = [];
  let previous: string[] = [];
  return version.nodes.map((node, index) => {
    const facts: RoutingFacts = {
      ...virtualFacts(ctx, version, data, index),
      previousApproverUserIds: previous,
      approvedUserIds: approved,
      chainUserIds: approved,
    };
    const expressions = approverExpressionsOf(node);
    const seats = simulatedSeats(node, expressions, version, data, facts);
    previous = [...new Set(expressions.flatMap((expression) => candidateOf(expression, data, facts) ?? []))];
    approved.push(...seats.flatMap((seat) => seat.approverUserId ?? []));
    const recipients = (recipient: ApprovalNode['messageRules'][number]['recipient']) =>
      recipient === 'owner'
        ? [initiatorUserId]
        : recipient === 'assignee'
          ? seats.map((seat) => seat.approverUserId)
          : [data.subjectUserId ?? null];
    const messages = node.messageRules.flatMap((rule) =>
      recipients(rule.recipient).map((recipientUserId) => ({
        trigger: rule.trigger,
        channels: rule.channels,
        template: rule.template,
        recipientUserId,
      })),
    );
    const base = { key: node.key, name: node.name, kind: nodeKindOf(node), exits: nodeExits(node) };
    const countersign = isCountersign(node) ? { approvers: seats } : {};
    return { ...base, formFields: node.formFields, messages, ...countersignSummary(node, seats), ...countersign };
  });
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
  const conditions = evaluateCondition(version.conditions, conditionContext(process.approvalType, request.data));
  const nodes = simulateNodes(ctx, version, request.data);
  const blockers = preflight(ctx, version, request.data);
  return {
    processId,
    versionNo: version.versionNo,
    versionStatus: version.status,
    conditions,
    nodes,
    blockers,
    startable: conditions.result && blockers.length === 0,
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
  // X-17 / F13：命中流程后继续无副作用地核算能否提交（与真实提交同一套预检）。
  const blockers = replica ? preflight(ctx, await loadVersion(tx, ctx.tenantId, replica.version.id), request.data) : [];
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
    replicaStartable: replica !== null && blockers.length === 0,
    replicaError: replica ? (blockers[0] ?? null) : noProcessMessage(request.approvalType),
  };
}
