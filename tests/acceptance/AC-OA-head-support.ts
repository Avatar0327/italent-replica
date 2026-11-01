import { randomUUID } from 'node:crypto';
import { type Db, eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { expect } from 'vitest';
import type { AuthorizationRequest, Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider, type ModuleScope } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { approvalWorld } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const MAIN = ORG_ADJUSTMENT_OBJECT_CODE;
export const ORG = MODULE_OBJECTS.organization.code;
export const BASE = '/api/tenant/org-adjustment/adjustments';
export const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
export const only = (...orgIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  orgIds,
  hasDataPermission: true,
  terms: [{ dimension: 'management', orgIds, personIds: [] }],
});

export interface AdjustmentView {
  id: string;
  code: string;
  subject: string;
  effectiveDate: string;
  content: string | null;
  approvalSubjectOrgId: string;
  adjustmentRange: string[];
  approvalStatus: number;
  executionStatus: number;
  revision: number;
}
interface StoredAdjustment {
  code: string;
  subject: string;
  effective_date: string;
  content: string | null;
  approval_subject_org_id: string;
  approval_status: number;
  revision: number;
  created_by: string;
  range: string[];
}

/** 被拒的按钮编码 / 字段编码；范围按对象分别给（申请单对象 = 主体组织层，组织对象 = 调整范围层）。 */
export interface HeadAccess {
  main: ModuleScope;
  org: ModuleScope;
  deniedButtons: Set<string>;
  deniedFields: Set<string>;
  /** 看不到的字段编码（查看权）。 */
  hiddenFields: Set<string>;
  /** 没有申请单对象查看权（object.view）。 */
  viewDenied?: boolean;
}

const catalogFields = (objectCode: string) =>
  new Set(
    Object.values(MODULE_OBJECTS)
      .find((o) => o.code === objectCode)
      ?.fields.map((f) => f.code) ?? [],
  );

/** 组织调整头写入世界：申请人 HR + 主体组织 + 两个可选组织；授权器按 access 控制按钮、字段与两层范围。 */
export async function headWorld(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  const subject = await w.org(`主体${uniqueSuffix()}`);
  const a = await w.org(`范围甲${uniqueSuffix()}`);
  const b = await w.org(`范围乙${uniqueSuffix()}`);
  const access: HeadAccess = {
    main: ALL,
    org: ALL,
    deniedButtons: new Set(),
    deniedFields: new Set(),
    hiddenFields: new Set(),
  };
  const decide = (req: AuthorizationRequest) => {
    if (req.action === 'object.button') return !access.deniedButtons.has(req.resource!.split('#')[1]!.split('@')[0]!);
    if (req.action === 'object.create' || req.action === 'object.update')
      return !(req.fields ?? []).some((f) => access.deniedFields.has(f));
    if (req.action === 'object.view' && req.resource === MAIN) return !access.viewDenied;
    return true;
  };
  const authorize: Authorizer = decide;
  registerScopeProvider(authorize, {
    scope: async (q) => (q.objectCode === MAIN ? access.main : q.objectCode === ORG ? access.org : ALL),
    authorize: async (req) => decide(req),
    fields: async (_tenantId, _userId, objectCode) =>
      new Set([...catalogFields(objectCode)].filter((f) => !access.hiddenFields.has(f))),
  });
  const api = tenantApi(w.db, { authorize, clock: w.clock });
  const call = (method: string, path: string, options: RequestOptions = {}, user = w.hr.id) =>
    api.request(method, path, { ...options, user, tenant: w.tenant.id });
  const head = (over: Record<string, unknown> = {}) => ({
    subject: `组织调整${uniqueSuffix()}`,
    effectiveDate: '2026-11-01',
    content: '调整说明',
    approvalSubjectOrgId: subject,
    adjustmentRange: [a],
    ...over,
  });
  const create = (body: Record<string, unknown> = head(), user = w.hr.id) =>
    call('POST', BASE, { ifMatch: 0, body }, user);
  async function created(body?: Record<string, unknown>): Promise<AdjustmentView> {
    const res = await create(body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as AdjustmentView;
  }
  /** @param ifMatch `null` 表示不带 If-Match。 */
  const patch = (id: string, body: Record<string, unknown>, ifMatch: number | null = 1, user = w.hr.id) =>
    call('PATCH', `${BASE}/${id}`, { ifMatch: ifMatch ?? undefined, body }, user);
  const voidIt = (id: string, ifMatch = 1, user = w.hr.id) =>
    call('POST', `${BASE}/${id}/void`, { ifMatch, body: {} }, user);
  const check = (id: string, user = w.hr.id) => call('POST', `${BASE}/${id}/check`, { body: {} }, user);

  /** 读库：申请单行 + 调整范围（按 seq）。 */
  async function stored(id: string): Promise<StoredAdjustment | undefined> {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<Omit<StoredAdjustment, 'range'>>(
        await tx.execute(sql`SELECT code, subject, effective_date::text AS effective_date, content,
          approval_subject_org_id, approval_status, revision, created_by FROM org_adjustments WHERE id = ${id}`),
      );
      if (!row) return undefined;
      const range = resultRows<{ org_id: string }>(
        await tx.execute(sql`SELECT org_id FROM org_adjustment_range_orgs WHERE adjustment_id = ${id} ORDER BY seq`),
      ).map((r) => r.org_id);
      return { ...row, range };
    });
  }
  /** 本租户申请单总数（拒绝路径断言“不留下数据”）。 */
  async function count(): Promise<number> {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ n: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*) FROM org_adjustments)::int + (SELECT count(*) FROM org_adjustment_range_orgs)::int AS n`),
      );
      return row!.n;
    });
  }
  async function audits(id: string): Promise<string[]> {
    return withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events
          WHERE object_type = 'org-adjustment' AND object_id = ${id} ORDER BY occurred_at, id`),
      ).map((r) => r.action),
    );
  }
  /** 可信夹具：直接改审批状态（提交 / 驳回路由不在本片）。 */
  async function setStatus(id: string, status: number) {
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE org_adjustments SET approval_status = ${status} WHERE id = ${id}`),
    );
  }
  /** 可信夹具：追加一条同开始日的停用版本（组织版本只允许追加，同 setOrgRoles）。 */
  async function disable(orgId: string) {
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, orgId))
        .orderBy(sql`version_no DESC`)
        .limit(1);
      const versionId = randomUUID();
      await tx
        .insert(orgVersions)
        .values({ ...old!, id: versionId, versionNo: old!.versionNo + 1, previousVersionId: old!.id, enabled: false });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
  }

  return {
    ...w,
    api,
    call,
    subject,
    a,
    b,
    access,
    authorize,
    head,
    create,
    created,
    patch,
    voidIt,
    check,
    stored,
    count,
    audits,
    setStatus,
    disable,
  };
}

export type HeadWorld = Awaited<ReturnType<typeof headWorld>>;

export async function bodyOf(res: Response): Promise<{
  error?: { code: string; message: string; details?: Record<string, unknown> };
}> {
  return (await res.clone().json()) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
}

/** 断言错误响应：状态码、错误码与（可选）details.reason。 */
export async function expectError(res: Response, status: number, code: string, reason?: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  const body = await bodyOf(res);
  expect(body.error?.code, text).toBe(code);
  if (reason) expect(body.error?.details?.reason, text).toBe(reason);
}
