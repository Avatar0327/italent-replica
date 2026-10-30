import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { resultRows } from './AC-ORG-people-support.js';
import { BASE, headWorld } from './AC-OA-head-support.js';

export interface ItemView {
  id: string;
  seq: number;
  adjustType: number;
  targetOrgId: string | null;
  parentOrgId: string | null;
  parentItemId: string | null;
  name: string | null;
  cascadedFromItemId: string | null;
  baseVersionId: string | null;
  baseOrgRevision: number | null;
  isStaged: boolean;
  [field: string]: unknown;
}
export interface ItemsResult {
  adjustmentId: string;
  revision: number;
  items: ItemView[];
}
export interface CheckIssue {
  section?: string;
  itemId?: string;
  reason: string;
  message?: string;
  orgId?: string;
}
export interface CheckResult {
  valid: boolean;
  errors: CheckIssue[];
  warnings: CheckIssue[];
  truncated?: boolean;
}
interface ItemRow {
  id: string;
  seq: number;
  adjust_type: number;
  target_org_id: string | null;
  parent_org_id: string | null;
  parent_item_id: string | null;
  cascaded_from_item_id: string | null;
  base_version_id: string | null;
  base_org_revision: number | null;
  is_staged: boolean;
  name: string | null;
}

/** 组织明细世界：在表头世界上加明细写入 / 刷新 / 读库与可信夹具（编制对象、组织外部改动）。 */
export async function itemsWorld(db: Db, label: string) {
  const w = await headWorld(db, label);
  /** 不给 ifMatch 时取库里当前 revision（多数用例只关心业务结果）。 */
  const ifMatchOf = async (id: string, ifMatch?: number) => ifMatch ?? (await w.stored(id))!.revision;
  const send = async (method: string, path: string, id: string, body: unknown, ifMatch?: number, user = w.hr.id) =>
    w.call(method, `${BASE}/${id}${path}`, { ifMatch: await ifMatchOf(id, ifMatch), body }, user);

  const addItem = (id: string, body: Record<string, unknown>, ifMatch?: number, user?: string) =>
    send('POST', '/org-items', id, body, ifMatch, user);
  const patchItem = (id: string, itemId: string, body: Record<string, unknown>, ifMatch?: number, user?: string) =>
    send('PATCH', `/org-items/${itemId}`, id, body, ifMatch, user);
  const deleteItem = (id: string, itemId: string, ifMatch?: number, user?: string) =>
    send('DELETE', `/org-items/${itemId}`, id, undefined, ifMatch, user);
  const rebaseItem = (id: string, itemId: string, ifMatch?: number, section = 'org') =>
    send('POST', `/items/${section}/${itemId}/rebase`, id, {}, ifMatch);
  const rebaseAll = (id: string, ifMatch?: number) => send('POST', '/rebase', id, {}, ifMatch);

  async function item(id: string, body: Record<string, unknown>): Promise<ItemsResult> {
    const res = await addItem(id, body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as ItemsResult;
  }
  async function checked(id: string): Promise<CheckResult> {
    const res = await w.check(id);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as CheckResult;
  }
  async function rows(id: string): Promise<ItemRow[]> {
    return withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<ItemRow>(
        await tx.execute(sql`SELECT id, seq, adjust_type, target_org_id, parent_org_id, parent_item_id,
          cascaded_from_item_id, base_version_id, base_org_revision, is_staged, name
          FROM org_adjustment_org_items WHERE adjustment_id = ${id} ORDER BY seq`),
      ),
    );
  }
  async function itemAudits(id: string): Promise<string[]> {
    return withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events WHERE object_type = 'org-adjustment-item'
          AND object_id IN (SELECT id FROM org_adjustment_org_items WHERE adjustment_id = ${id})
          ORDER BY occurred_at, id`),
      ).map((r) => r.action),
    );
  }
  /** 可信夹具：组织被外部改动（revision + 1，模拟直接改组织）。 */
  async function touchOrg(orgId: string) {
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE org_objects SET revision = revision + 1 WHERE id = ${orgId}`),
    );
  }
  /** 可信夹具：给组织挂一个覆盖生效日的编制对象（只供 11e 前的编制结束关口判断）。 */
  async function capacity(orgId: string) {
    const schemeId = randomUUID();
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(
        sql`INSERT INTO establishment_scheme_objects (id, tenant_id) VALUES (${schemeId}, ${w.tenant.id})`,
      );
      await tx.execute(sql`INSERT INTO establishment_objects (tenant_id, org_id, scheme_id, period_start, period_end)
        VALUES (${w.tenant.id}, ${orgId}, ${schemeId}, '2026-01-01', '2026-12-31')`);
    });
  }

  return {
    ...w,
    addItem,
    patchItem,
    deleteItem,
    rebaseItem,
    rebaseAll,
    item,
    checked,
    rows,
    itemAudits,
    touchOrg,
    capacity,
  };
}

export type ItemsWorld = Awaited<ReturnType<typeof itemsWorld>>;

/** 常用载荷：在 parent 下新建；改名；停用。 */
export const newOrg = (parentOrgId: string, over: Record<string, unknown> = {}) => ({
  entry: 'detail.create',
  adjustType: 1,
  parent: { orgId: parentOrgId },
  name: `新组织${randomUUID()}`,
  ...over,
});
export const rename = (targetOrgId: string, over: Record<string, unknown> = {}) => ({
  entry: 'detail.change',
  adjustType: 2,
  targetOrgId,
  name: `改名${randomUUID()}`,
  addEmployment: false,
  ...over,
});
export const stop = (targetOrgId: string, over: Record<string, unknown> = {}) => ({
  entry: 'detail.stop',
  adjustType: 3,
  targetOrgId,
  ...over,
});
export const reasons = (result: CheckResult) => result.errors.map((e) => e.reason);
