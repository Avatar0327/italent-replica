import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { expect } from 'vitest';
import { BASE, type HeadWorld } from './AC-OA-head-support.js';
import { resultRows } from './AC-ORG-people-support.js';

/** R2-T08 BE-10d 读接口（路由 12～15）的响应形状与调用助手。 */
export interface RangeOrg {
  orgId: string;
  name: string | null;
  label: string | null;
}
export interface ListRow {
  id: string;
  [field: string]: unknown;
}
export interface ListResult {
  items: ListRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface DetailView {
  id: string;
  approvalInstanceId: string | null;
  sections: Record<string, { count: number; hiddenRowCount: number }>;
  [field: string]: unknown;
}
export interface ReadItem {
  id: string;
  seq: number;
  [field: string]: unknown;
}
export interface ItemsView {
  adjustmentId: string;
  section: string;
  items: ReadItem[];
  hiddenRowCount: number;
}
export interface PreviewNode {
  key: string;
  orgId: string | null;
  itemId: string | null;
  name: string | null;
  /** 在岗 / 兼岗原值（生效日起，直属本组织）；看不到既有组织属性时为 null。 */
  onDutyCount: number | null;
  partTimeCount: number | null;
  mark: 'added' | 'changed' | 'deactivated' | null;
  masked: string[];
  children: PreviewNode[];
}
export interface PreviewView {
  adjustmentId: string;
  effectiveDate: string;
  roots: PreviewNode[];
}

/** 读接口助手：`ok` 系列断言 200 并解析；裸调用返回 Response 供拒绝路径断言。 */
export function reader(w: HeadWorld) {
  const get = (path: string, user = w.hr.id) => w.call('GET', path, {}, user);
  const listRes = (query = '', user?: string) => get(`${BASE}${query ? `?${query}` : ''}`, user);
  const detailRes = (id: string, user?: string) => get(`${BASE}/${id}`, user);
  const itemsRes = (id: string, section = 'org', user?: string) => get(`${BASE}/${id}/items/${section}`, user);
  const previewRes = (id: string, user?: string) => get(`${BASE}/${id}/preview`, user);
  const ok = async <T>(res: Response | Promise<Response>): Promise<T> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as T;
  };
  return {
    listRes,
    detailRes,
    itemsRes,
    previewRes,
    list: (query = '', user?: string) => ok<ListResult>(listRes(query, user)),
    detail: (id: string, user?: string) => ok<DetailView>(detailRes(id, user)),
    items: (id: string, user?: string) => ok<ItemsView>(itemsRes(id, 'org', user)),
    preview: (id: string, user?: string) => ok<PreviewView>(previewRes(id, user)),
  };
}

/** 预览树拍平成节点列表（深度优先）。 */
export function flatten(nodes: PreviewNode[]): PreviewNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/**
 * 可信夹具：发布一条组织调整流程（formFields 由用例给），再直接插入运行中的审批实例与 approver 的待办
 * （提交路由与审批人解析属 BE-10c，不在本片；读接口只看任务归属与节点 formFields）。
 */
export async function approvalFixture(
  w: HeadWorld,
  adjustmentId: string,
  approver: string,
  formFields: readonly string[],
) {
  const process = await w.publishedProcess({
    approvalType: 'org_adjustment',
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'OrganizationProcess' }] },
    nodes: [{ key: 'n1', approver: { type: 'object_field', value: 'approval_subject_org_hrbp' }, formFields }],
  });
  const instanceId = randomUUID();
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`INSERT INTO approval_instances
      (id, tenant_id, process_id, version_id, approval_type, object_code, business_type, business_id,
        initiator_user_id, process_code, title, status, current_node_key)
      VALUES (${instanceId}, ${w.tenant.id}, ${process.id}, ${process.currentVersion!.id}, 'org_adjustment',
        ${ORG_ADJUSTMENT_OBJECT_CODE}, 'org_adjustment', ${adjustmentId}, ${w.hr.id}, 'OrganizationProcess',
        '合成组织调整', 'running', 'n1')`);
    await tx.execute(sql`INSERT INTO approval_tasks
      (tenant_id, instance_id, seq, round, node_key, assignee_user_id, origin, status)
      VALUES (${w.tenant.id}, ${instanceId}, 1, 1, 'n1', ${approver}, 'resolved', 'pending')`);
  });
  return instanceId;
}

/** 读库：组织在 asOf 的名称（最新版本），用于断言名称列。 */
export async function orgName(w: HeadWorld, orgId: string, asOf = '2026-11-01'): Promise<string> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const rows = resultRows<{ name: string }>(
      await tx.execute(sql`SELECT name FROM org_versions WHERE org_id = ${orgId}
        AND start_date <= ${asOf}::date ORDER BY start_date DESC, version_no DESC LIMIT 1`),
    );
    return rows[0]!.name;
  });
}

/** 可信夹具：写明细执行结果（执行器属 BE-11b）。 */
export async function setItemResult(w: HeadWorld, itemId: string, result: 1 | 2, reason: string | null) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE org_adjustment_org_items SET execution_result = ${result}, execution_reason = ${reason},
      execution_message = ${reason ? '合成失败说明' : null} WHERE id = ${itemId}`),
  );
}
