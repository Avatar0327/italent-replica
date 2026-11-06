/**
 * F-478 节点出口分支的读写与校验（设计 §2、§2.4）。路由随流程版本冻结：草稿整体替换时先清后写，已发布版本只读（迁移 0197 触发器）。
 * 本片只在进程内读写，HTTP 草稿入参 schema 不开放 routes。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  conditionViolations,
  ROUTE_END,
  validateRoutes,
  type ApprovalNode,
  type ApprovalTypeCode,
  type ExitRoute,
  type ProcessDefinition,
  type RouteBranch,
  type RouteViolation,
} from '@italent/domain';
import type { AppError } from '../../errors.js';
import { conditionItem, insertConditionItem } from './condition-rows.js';
import { approvalError, rowsOf, type Row } from './context.js';

/** 3 个出口 × 10 个分支 × 50 个节点 / 每分支 20 条件项：读取的有界上限（设计 §2.2）。 */
const MAX_ROUTE_ROWS = 1500;
const MAX_ROUTE_CONDITION_ROWS = 30000;

/** 版本内全部节点的出口分支：节点 key → 出口分支列表（只含配置过的节点）。 */
export async function loadRoutes(tx: Tx, tenantId: string, versionId: string): Promise<Map<string, ExitRoute[]>> {
  const routeRows = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_node_exit_routes
      WHERE tenant_id=${tenantId} AND version_id=${versionId}::uuid
      ORDER BY node_key,exit,branch_no LIMIT ${MAX_ROUTE_ROWS}`),
  );
  if (!routeRows.length) return new Map();
  const conditionRows = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_node_exit_route_conditions
      WHERE tenant_id=${tenantId} AND version_id=${versionId}::uuid
      ORDER BY node_key,exit,branch_no,item_no LIMIT ${MAX_ROUTE_CONDITION_ROWS}`),
  );
  const items = new Map<string, Row[]>();
  for (const row of conditionRows) {
    const key = `${row.node_key}/${row.exit}/${row.branch_no}`;
    items.set(key, [...(items.get(key) ?? []), row]);
  }
  const byNode = new Map<string, ExitRoute[]>();
  for (const row of routeRows) {
    const nodeKey = String(row.node_key);
    const exit = String(row.exit);
    const list = byNode.get(nodeKey) ?? [];
    let route = list.find((entry) => entry.exit === exit);
    if (!route) {
      route = { exit, branches: [] };
      list.push(route);
    }
    (route.branches as RouteBranch[]).push(branchOf(row, items.get(`${nodeKey}/${exit}/${row.branch_no}`) ?? []));
    byNode.set(nodeKey, list);
  }
  return byNode;
}

function branchOf(row: Row, conditionRows: Row[]): RouteBranch {
  const target = (row.target_node_key as string | null) ?? ROUTE_END;
  if (row.kind !== 'condition') return { kind: row.kind as RouteBranch['kind'], target };
  return {
    kind: 'condition',
    priority: Number(row.priority),
    conditions: { expression: String(row.expression), items: conditionRows.map(conditionItem) },
    target,
  };
}

/** 读出的节点挂上分支；没有配置的节点保持原形状（不增加字段）。 */
export function withLoadedRoutes(nodes: readonly ApprovalNode[], routes: Map<string, ExitRoute[]>): ApprovalNode[] {
  return nodes.map((node) => (routes.has(node.key) ? { ...node, routes: routes.get(node.key)! } : node));
}

/** 所有节点已落库后写入各出口分支（目标节点外键要求目标先存在）。 */
export async function writeRoutes(
  tx: Tx,
  tenantId: string,
  versionId: string,
  nodes: readonly ApprovalNode[],
): Promise<void> {
  for (const node of nodes) {
    for (const route of node.routes ?? []) {
      for (const [index, branch] of route.branches.entries()) {
        const branchNo = index + 1;
        const target = branch.target === ROUTE_END ? null : branch.target;
        const conditioned = branch.kind === 'condition' ? branch.conditions : undefined;
        await tx.execute(sql`INSERT INTO approval_node_exit_routes
          (tenant_id,version_id,node_key,exit,branch_no,kind,priority,expression,target_node_key)
          VALUES (${tenantId},${versionId}::uuid,${node.key},${route.exit},${branchNo},${branch.kind},
            ${conditioned ? (branch.priority ?? null) : null},
            ${conditioned ? conditioned.expression || conditioned.items.map((item) => item.no).join(' and ') : null},
            ${target})`);
        for (const item of conditioned?.items ?? []) {
          const at = { kind: 'route', nodeKey: node.key, exit: route.exit, branchNo } as const;
          await insertConditionItem(tx, tenantId, versionId, at, item);
        }
      }
    }
  }
}

/** 草稿整体替换时，入参没带 routes 的节点沿用当前草稿的分支（空数组表示显式清空）；与回避开关同一思路。 */
export function inheritRoutes(definition: ProcessDefinition, current: readonly ApprovalNode[]): ProcessDefinition {
  const byKey = new Map(current.map((node) => [node.key, node]));
  const nodes = definition.nodes.map((node) => {
    if (node.routes !== undefined) return node;
    const before = byKey.get(node.key)?.routes;
    return before?.length ? { ...node, routes: before } : node;
  });
  return { ...definition, nodes };
}

function violationMessage(violation: RouteViolation, nodes: readonly ApprovalNode[], type: ApprovalTypeCode): string {
  const at = [violation.nodeKey, violation.exit, violation.branchNo].filter((part) => part !== undefined).join(' / ');
  const branch = nodes
    .find((node) => node.key === violation.nodeKey)
    ?.routes?.find((route) => route.exit === violation.exit)?.branches[(violation.branchNo ?? 0) - 1];
  const original =
    violation.reason === 'invalid_condition' && branch?.conditions
      ? `：${conditionViolations(branch.conditions, APPROVAL_TYPES[type].conditionFields).join('；')}`
      : '';
  return `节点分支配置不合法（${violation.reason}，${at}）${original}`;
}

/**
 * 保存草稿与发布时统一校验；违规一律 400 VALIDATION_FAILED，`details.reason` 为机器可读的精确原因。
 * 不可达节点只在发布时拦（设计 §2.4）：草稿编辑中途允许暂时孤立。
 */
export function assertRoutesValid(nodes: readonly ApprovalNode[], type: ApprovalTypeCode, publishing = false): void {
  const [violation] = validateRoutes(nodes, APPROVAL_TYPES[type].conditionFields, type).filter(
    (found) => publishing || found.reason !== 'unreachable_node',
  );
  if (!violation) return;
  throw routeError(violation, violationMessage(violation, nodes, type));
}

function routeError(violation: RouteViolation, message: string): AppError {
  return approvalError('VALIDATION_FAILED', violation.reason, message, {
    code: 'APPROVAL_ROUTE_INVALID',
    nodeKey: violation.nodeKey,
    ...(violation.exit === undefined ? {} : { exit: violation.exit }),
    ...(violation.branchNo === undefined ? {} : { branchNo: violation.branchNo }),
  });
}
