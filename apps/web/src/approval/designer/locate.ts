/**
 * F-478 S7 保存被拒时的定位（设计 §2.2、§4）：400 `APPROVAL_ROUTE_INVALID` 按 details 的 nodeKey / exit / branchNo 定位；
 * 422 `APPROVAL_SOURCE_INVALID` 的 details 只有 reason，按服务端逐节点、按顺序校验的口径在本地找出第一个出错节点。
 */
import {
  APPROVAL_TYPES,
  approverSourceViolations,
  approverSourcesOf,
  isUnselectedSpecified,
  type ApprovalNode,
  type ProcessDefinition,
} from '@italent/domain';
import type { ApiClient } from '../../foundation/client.js';
import type { Values } from '../../foundation/forms/values.js';
import { nodeField } from './model.js';
import { RouteInputError, exitLabel } from './routes.js';
import { r } from './route-messages.js';
import { REFERENCE_SOURCE_TYPES, sourceFields } from './sources.js';
import { DesignerError } from './write.js';

export interface Located {
  readonly nodeKey: string;
  readonly area: 'routes' | 'sources';
  readonly exit?: string;
  readonly branchNo?: number;
}
interface Context {
  /** 本次提交的整份草稿；本地组装失败时没有。 */
  readonly draft: ProcessDefinition | undefined;
  readonly edited: Values;
  readonly approvalType: string;
  readonly api: ApiClient;
}
const sourcesOf = (node: ApprovalNode) => [...approverSourcesOf(node), ...(node.emptyApproverSources ?? [])];
const specifiedIds = (node: ApprovalNode) =>
  sourcesOf(node)
    .filter((source) => source.type === 'specified' && !isUnselectedSpecified(source))
    .map((source) => source.value);
const editedSources = (node: ApprovalNode, edited: Values) =>
  sourceFields(node).some((field) => nodeField(node.key, field) in edited);

/** 候选接口只返回本租户有效成员：服务端拒绝时重新核对，第一个含失效人员的节点即服务端报错的节点。 */
async function invalidPersonNode(nodes: readonly ApprovalNode[], api: ApiClient) {
  const ids = [...new Set(nodes.flatMap(specifiedIds))];
  const valid = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const query = new URLSearchParams({ userIds: ids.slice(offset, offset + 100).join(',') });
    const result = await api.request<{ items: { userId: string }[] }>(
      `/api/tenant/approval/designer/person-candidates?${query}`,
    );
    result.items.forEach((item) => valid.add(item.userId));
  }
  return nodes.find((node) => specifiedIds(node).some((id) => !valid.has(id)));
}
async function sourceNode(reason: unknown, { draft, edited, approvalType, api }: Context) {
  const nodes = draft?.nodes ?? [];
  const type = APPROVAL_TYPES[approvalType as keyof typeof APPROVAL_TYPES];
  if (reason === 'APPROVAL_DEFINITION_INVALID' && type)
    return nodes.find((node) => approverSourceViolations(node, type).length);
  if (reason === 'APPROVAL_SOURCE_USER_INVALID') return invalidPersonNode(nodes, api).catch(() => undefined);
  if (reason === 'APPROVAL_SOURCE_REFERENCE_INVALID' || reason === 'APPROVAL_SOURCE_DIMENSION_DISABLED') {
    // 引用是否仍可用只有服务端知道：先看本次改过来源的节点，再按顺序取第一个带引用来源的节点。
    const referencing = nodes.filter((node) =>
      sourcesOf(node).some((source) => REFERENCE_SOURCE_TYPES.includes(source.type)),
    );
    return referencing.find((node) => editedSources(node, edited)) ?? referencing[0];
  }
  return undefined;
}

/** 本地拦截的分支错误（未选去向等）直接带着节点与分支。 */
export function localSpot(error: unknown): Located | undefined {
  if (!(error instanceof RouteInputError)) return undefined;
  return { nodeKey: error.nodeKey, area: 'routes', exit: error.exit, branchNo: error.branchNo };
}
/** 返回带定位文案的错误；找不到节点时原样返回，页面只显示服务端原因。 */
export async function locateRejection(
  error: unknown,
  context: Context,
): Promise<{ error: unknown; located?: Located }> {
  const spot = localSpot(error);
  if (spot) return { error, located: spot };
  if (!(error instanceof DesignerError)) return { error };
  const { details } = error;
  const name = (key: string) => context.draft?.nodes.find((node) => node.key === key)?.name ?? key;
  if (error.code === 'VALIDATION_FAILED' && details.code === 'APPROVAL_ROUTE_INVALID') {
    const nodeKey = typeof details.nodeKey === 'string' ? details.nodeKey : undefined;
    if (!nodeKey) return { error };
    const exit = typeof details.exit === 'string' ? details.exit : undefined;
    const branchNo = typeof details.branchNo === 'number' ? details.branchNo : undefined;
    const reason = r.reasons[String(details.reason)] ?? r.invalidRoute;
    const message = `${r.at(name(nodeKey), exit && exitLabel(exit), branchNo)}：${reason}`;
    const located: Located = { nodeKey, area: 'routes', exit, branchNo };
    return { error: error.located(message), located };
  }
  if (error.code !== 'APPROVAL_SOURCE_INVALID') return { error };
  const node = await sourceNode(details.reason, context);
  if (!node) return { error };
  const message = `${r.at(node.name)} · ${r.sources}：${error.serverMessage ?? error.message}`;
  return { error: error.located(message), located: { nodeKey: node.key, area: 'sources' } as Located };
}
