/**
 * F-478 S1 验收夹具：条件分支只能由定义服务在进程内写入（HTTP 草稿 schema 本片不开放 routes），
 * 所以流程先经公开接口建草稿，再在 withTenant 内用 replaceDraft / publishProcess 写入并发布路由。
 * 审批人一律用“指定人员”，路径上谁办理一目了然；所有租户数据读写都放进 withTenant（DEC-568）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import type { ApprovalNode } from '@italent/domain';
import {
  loadProcess,
  newVersion,
  publishProcess,
  replaceDraft,
} from '../../apps/api/src/modules/approval/definitions.js';
import {
  approvalWorld,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type Person,
  type ProcessView,
} from './AC-APV-support.js';
import type { Db } from '@italent/db';

export const APV = '/api/tenant/approval';

export interface BranchInput {
  readonly kind: 'condition' | 'else' | 'direct';
  readonly priority?: number;
  readonly conditions?: {
    readonly items: readonly {
      no: number;
      field: string;
      operator: string;
      value: string | readonly string[] | null;
    }[];
    readonly expression: string;
  };
  /** 节点 key 或 END。 */
  readonly target: string;
}
export interface ExitRouteInput {
  readonly exit: string;
  readonly branches: readonly BranchInput[];
}
/** 节点 key → 该节点各出口的分支。 */
export type RoutesInput = Readonly<Record<string, readonly ExitRouteInput[]>>;

const DEPARTMENT = 'record.departmentId';

/** 单条件分支：字段取本条记录部门（组织字段），值与发起条件同形。 */
export function when(
  priority: number,
  operator: 'eq' | 'ne' | 'in' | 'not_in' | 'is_empty' | 'not_empty',
  value: string | readonly string[] | null,
  target: string,
  field = DEPARTMENT,
): BranchInput {
  return {
    kind: 'condition',
    priority,
    conditions: { items: [{ no: 1, field, operator, value }], expression: '1' },
    target,
  };
}
export const otherwise = (target: string): BranchInput => ({ kind: 'else', target });
export const direct = (target: string): BranchInput => ({ kind: 'direct', target });
export const approveTo = (...branches: BranchInput[]): ExitRouteInput => ({ exit: 'approve', branches });
export const disagreeTo = (...branches: BranchInput[]): ExitRouteInput => ({ exit: 'disagree', branches });

export interface RouteScene {
  readonly w: ApprovalWorld;
  readonly home: string;
  readonly depts: Record<'d1' | 'd2' | 'd3', string>;
  /** N1～N4 的审批人（互不相同）。 */
  readonly people: Record<'n1' | 'n2' | 'n3' | 'n4', Person>;
  nodes(overrides?: Partial<Record<'n1' | 'n2' | 'n3' | 'n4', Partial<NodeInput>>>): NodeInput[];
  /** 新建一名在原部门任职的员工并发起转入 dept 的调动申请。 */
  start(dept: string | null): Promise<InstanceView>;
  /** 以已有的人为被调动对象发起（该人是本单涵盖主体，开启多主体回避的节点会自动跳过他）。 */
  startAbout(person: Person, dept: string | null): Promise<InstanceView>;
}

const KEYS = ['n1', 'n2', 'n3', 'n4'] as const;

export async function routeScene(db: Db, label: string): Promise<RouteScene> {
  const w = await approvalWorld(db, label);
  const home = await w.org('原部门');
  const depts = { d1: await w.org('分支部门一'), d2: await w.org('分支部门二'), d3: await w.org('分支部门三') };
  const people = {} as Record<(typeof KEYS)[number], Person>;
  for (const key of KEYS) people[key] = await w.person(`审批人${key}`, home);
  let counter = 0;
  return {
    w,
    home,
    depts,
    people,
    nodes(overrides = {}) {
      return KEYS.map((key) => ({
        key,
        name: `节点${key}`,
        approver: { type: 'specified', value: people[key].userId },
        actions: { rejectToPrevious: true, jump: true, retrieve: true, reject: true },
        ...overrides[key],
      })) as NodeInput[];
    },
    async start(dept) {
      counter += 1;
      return this.startAbout(await w.person(`调动员工${counter}`, home), dept);
    },
    async startAbout(person, dept) {
      const application = await w.application(person.employeeId, dept === null ? {} : { departmentId: dept });
      return w.submit(application);
    },
  };
}

const ctxOf = (w: ApprovalWorld, expectedRevision: number) => ({
  tenantId: w.tenant.id,
  userId: w.hr.id,
  timezone: 'Asia/Shanghai',
  now: new Date('2026-10-01T01:00:00.000Z'),
  commandId: randomUUID(),
  expectedRevision,
});

/** 把路由挂到节点上（类型上 routes 属于领域节点，夹具节点没有，所以收窄转换）。 */
function withRoutes(nodes: readonly ApprovalNode[], routes: RoutesInput): ApprovalNode[] {
  return nodes.map((node) => ({ ...node, routes: routes[node.key] ?? [] }) as ApprovalNode);
}

/** 经公开接口建草稿，再进程内写入路由并发布。 */
export async function publishRouted(w: ApprovalWorld, nodes: readonly NodeInput[], routes: RoutesInput) {
  const created = await w.createProcess({ nodes });
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const current = await loadProcess(tx, w.tenant.id, created.id);
    const changed = await replaceDraft(tx, ctxOf(w, current.revision), created.id, {
      ...current.latestVersion,
      nodes: withRoutes(current.latestVersion.nodes, routes),
    });
    await publishProcess(tx, ctxOf(w, changed.revision), created.id);
  });
  return created;
}

/** 在已发布流程上再发一版（替换路由，节点不变）。 */
export async function republishRouted(w: ApprovalWorld, process: ProcessView, routes: RoutesInput) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const current = await loadProcess(tx, w.tenant.id, process.id);
    const draft = await newVersion(tx, ctxOf(w, current.revision), process.id);
    const changed = await replaceDraft(tx, ctxOf(w, draft.revision), process.id, {
      ...draft.latestVersion,
      nodes: withRoutes(draft.latestVersion.nodes, routes),
    });
    await publishProcess(tx, ctxOf(w, changed.revision), process.id);
  });
}

/** 加载器读回的最新版本（含路由），供往返断言。 */
export async function latestVersionOf(w: ApprovalWorld, processId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => (await loadProcess(tx, w.tenant.id, processId)).latestVersion);
}

export interface ActivationRow {
  node_key: string;
  entry_kind: string;
  from_node_key: string | null;
  from_exit: string | null;
  from_branch_no: number | null;
  activation_id: string;
  from_activation_id: string | null;
}

/** 实例的全部激活行（按进入顺序）。 */
export async function activationsOf(w: ApprovalWorld, instanceId: string): Promise<ActivationRow[]> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT activation_id,node_key,entry_kind,from_node_key,from_exit,
        from_branch_no,from_activation_id
      FROM approval_node_activations WHERE tenant_id=${w.tenant.id} AND instance_id=${instanceId}::uuid
      ORDER BY created_seq,node_key,activation_id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as ActivationRow[];
  });
}

/** 当前待办（按节点）。 */
export const pendingOf = (view: InstanceView) => view.tasks.filter((task) => task.status === 'pending');

/** 当前待办所在节点 key（单人节点流程里恰好一个）。 */
export function pendingKey(view: InstanceView): string | undefined {
  const [task, ...rest] = pendingOf(view);
  return rest.length ? undefined : task?.nodeKey;
}

/** 当前节点的审批人同意（出口缺省为 approve）。 */
export async function approveCurrent(s: RouteScene, view: InstanceView, comment = '同意'): Promise<InstanceView> {
  const task = pendingOf(view)[0]!;
  const response = await s.w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, { comment });
  await s.w.json(response);
  return s.w.detail(view.id);
}

export async function disagreeCurrent(s: RouteScene, view: InstanceView): Promise<InstanceView> {
  const task = pendingOf(view)[0]!;
  await s.w.json(await s.w.taskAction(task.assigneeUserId, task.id, 'disagree', view.revision, { comment: '不同意' }));
  return s.w.detail(view.id);
}

/** 驳回到上一步 / 跳转 / 撤回等任务级动作（路径 /tasks/:id/<action>）。 */
export async function taskPost(
  s: RouteScene,
  view: InstanceView,
  action: 'reject-previous' | 'jump' | 'retrieve',
  body: Record<string, unknown> = {},
  taskId?: string,
  actor?: string,
) {
  const task = taskId ? view.tasks.find((t) => t.id === taskId)! : pendingOf(view)[0]!;
  return s.w.request(actor ?? task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/${action}`, {
    ifMatch: view.revision,
    body,
  });
}

/** 一路同意直到结束，返回途经的节点 key（含最后一个被办理的节点）。 */
export async function walkApproving(
  s: RouteScene,
  first: InstanceView,
): Promise<{ path: string[]; view: InstanceView }> {
  const path: string[] = [];
  let view = first;
  for (let step = 0; step < 10 && pendingOf(view).length; step += 1) {
    path.push(pendingKey(view)!);
    view = await approveCurrent(s, view);
  }
  return { path, view };
}

/** 驳回后在申请单上改字段再重提（任职申请的重提只能经业务单，适配器 resubmit 会拒绝）。 */
export async function resubmitWith(s: RouteScene, view: InstanceView, fields: Record<string, unknown>) {
  const business = await s.w.business(view.businessId);
  const patched = await s.w.json<{ revision: number }>(
    await s.w.request(s.w.hr.id, 'PATCH', `/api/tenant/employment/businesses/${view.businessId}`, {
      ifMatch: business.revision,
      body: { fields },
    }),
  );
  await s.w.json(await s.w.submitRaw({ id: view.businessId, revision: patched.revision }));
  return s.w.detail(view.id);
}
