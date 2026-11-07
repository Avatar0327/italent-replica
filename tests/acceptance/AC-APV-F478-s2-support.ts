/**
 * F-478 S2 验收夹具：与 S1 夹具不同，这里的路由一律经真实 HTTP 入口（PUT 草稿 / POST 办理 / GET 详情与仿真）写入和读取，
 * 不走进程内的定义服务。所有租户数据读写仍放进 withTenant（DEC-568）。
 */
import type { ApprovalWorld, InstanceView, NodeInput, ProcessView, VersionView } from './AC-APV-support.js';
import { APV, type RoutesInput } from './AC-APV-F478-support.js';

/** 带 routes 的节点入参（夹具的 NodeInput 属于旧契约，没有 routes，所以扩一层）。 */
export type RoutedNodeInput = NodeInput & { readonly routes?: readonly unknown[] };

export function withRoutesOn(nodes: readonly NodeInput[], routes: RoutesInput): RoutedNodeInput[] {
  return nodes.map((node) => (routes[node.key] ? { ...node, routes: routes[node.key] } : node));
}

/** 旧设计器的草稿体：把读回的版本剔除元数据后整体 PUT（apps/web buildDraft 同形）。 */
export function cloneForPut(version: VersionView, patch: Record<string, unknown> = {}) {
  const {
    id: _id,
    versionNo: _no,
    status: _status,
    publishedAt: _at,
    ...definition
  } = structuredClone(version) as VersionView & { publishedAt?: unknown };
  return { ...definition, ...patch };
}

/** PUT 草稿；返回原始响应，由用例断言状态。 */
export function putDraft(w: ApprovalWorld, process: ProcessView, body: unknown, ifMatch = process.revision) {
  return w.request(w.hr.id, 'PUT', `${APV}/processes/${process.id}/draft`, { ifMatch, body });
}

/** 经 HTTP 建出只有线性节点的草稿，再 PUT 路由并发布；返回发布后的流程。 */
export async function publishViaHttp(w: ApprovalWorld, nodes: readonly NodeInput[], routes: RoutesInput) {
  const created = await w.createProcess({ nodes });
  const saved = await w.json<ProcessView>(
    await putDraft(
      w,
      created,
      cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, routes) }),
    ),
  );
  return w.publish(saved);
}

export async function getProcess(w: ApprovalWorld, id: string, actor = w.hr.id): Promise<ProcessView> {
  return w.json<ProcessView>(await w.request(actor, 'GET', `${APV}/processes/${id}`));
}

/** 详情上 S2 新增的披露字段。 */
export interface ExitView {
  readonly code: string;
  readonly label: string;
  readonly family: 'approve' | 'disagree';
}
export interface PathStep {
  readonly nodeKey: string;
  readonly name: string;
  readonly state: 'passed' | 'current' | 'pending' | 'not_on_path';
  readonly exit?: string;
}
export type DetailWithExits = InstanceView & {
  readonly actions: readonly string[];
  readonly exits?: readonly ExitView[];
  readonly path?: readonly PathStep[];
};

export async function detailOf(w: ApprovalWorld, instanceId: string, actor = w.hr.id): Promise<DetailWithExits> {
  return (await w.detail(instanceId, actor)) as DetailWithExits;
}

/** 读出错误信封里的状态、顶层码与机器原因。 */
export async function errorInfo(response: Response) {
  const body = (await response.json()) as {
    error?: {
      code?: string;
      details?: { reason?: string; code?: string; nodeKey?: string; exit?: string; branchNo?: number };
    };
  };
  return {
    status: response.status,
    code: body.error?.code,
    reason: body.error?.details?.reason,
    detailCode: body.error?.details?.code,
    nodeKey: body.error?.details?.nodeKey,
    exit: body.error?.details?.exit,
    branchNo: body.error?.details?.branchNo,
  };
}
