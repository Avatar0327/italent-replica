/**
 * F-476 P6 验收夹具：Offer 单 / Offer 批的「办理时」与「事后改动」两个时间点。
 * 办理份只经 withTenant 查询（app_owner + FORCE RLS 下也能通过）；内容一律合成（ZZ_ 前缀）。
 * 断言刻意只用 HTTP 返回与 jsonb 文本，不依赖办理份内部形状（形状由实现决定，设计 §3）。
 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, type ObjectDefinition } from '@italent/domain';
import { expect } from 'vitest';
import { grantFieldAccess, permissionAdmin, type InstanceView, type Person } from './AC-APV-support.js';
import type { offerApprovalWorld, OfferView } from './AC-OF-BE14a3-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import type { Copy } from './AC-F476-support.js';
import { tenantApi } from './support/tenant-api.js';

export type World = Awaited<ReturnType<typeof offerApprovalWorld>>;
export const APPROVAL = '/api/tenant/approval';
export const OFFERS = '/api/tenant/offers';
export const PLACE_A = 'ZZ_办理时地点';
export const PLACE_B = 'ZZ_事后地点';
export const NAME_A1 = 'ZZ_甲候选人';
export const NAME_A2 = 'ZZ_乙候选人';
export const NAME_B1 = 'ZZ_事后改名';
export const SALARY_A = 6000;
export const SALARY_B = 8800;
export const OFFER_FIELD_CODES = MODULE_OBJECTS.offer.fields.map((field) => field.code);

/** 红测的“行为式失败”：表不存在时先断言失败，而不是抛 SQL 错误。 */
async function expectTable(w: World) {
  const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ t: string | null }>(
      await tx.execute(sql`SELECT to_regclass('approval_handling_contents')::text AS t`),
    ),
  );
  expect(row?.t, '缺少 approval_handling_contents 表').toBe('approval_handling_contents');
}

/** 某实例的全部办理份（按办理日志序号）。 */
export async function copiesFor(w: World, instanceId: string): Promise<Copy[]> {
  await expectTable(w);
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<Copy>(
      await tx.execute(sql`SELECT c.id::text, c.task_id::text, c.handling_log_id::text, c.round, c.node_key,
        c.actor_user_id::text, c.handling_kind, c.action, c.business_type, c.content_schema_version, c.payload_bytes,
        l.event, c.content::text AS text
        FROM approval_handling_contents c
        JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
        WHERE c.instance_id = ${instanceId} ORDER BY l.seq`),
    ),
  );
}

/** 建一份带地点 / 薪资 / 直接上级的 Offer（实习类型，只必填 4 项）。 */
export async function createOffer(w: World, name: string, extra: Record<string, unknown> = {}): Promise<OfferView> {
  const body = {
    entry: 'intern',
    name,
    personalEmail: `p6-${name.length}-${Math.random().toString(36).slice(2)}@example.com`,
    departmentId: w.department,
    plannedEntryDate: '2026-11-01',
    salaryAfterRegular: SALARY_A,
    workPlace: PLACE_A,
    directManagerId: w.manager.employeeId,
    ...extra,
  };
  return w.json<OfferView>(await w.request(w.applicant.userId, 'POST', OFFERS, { ifMatch: 0, body }), 201);
}

/** 申请人在 Offer 上改字段（驳回 / 不同意后回到可编辑状态才允许）。 */
export async function editOffer(w: World, id: string, patch: Record<string, unknown>): Promise<OfferView> {
  const current = await w.get(id);
  return w.json<OfferView>(
    await w.request(w.applicant.userId, 'PUT', `${OFFERS}/${id}`, { ifMatch: current.revision, body: patch }),
  );
}

/** 某业务的全部审批实例 ID（重新发起可能新建实例，w.instance 只认唯一一条）。 */
export async function instanceIdsOf(w: World, businessId: string): Promise<string[]> {
  const response = await w.request(
    w.applicant.userId,
    'GET',
    `${APPROVAL}/instances?role=initiated&businessId=${businessId}`,
  );
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

export async function pendingTask(w: World, view: InstanceView, actor: Person) {
  const task = w.pending(view).find((t) => t.assigneeUserId === actor.userId);
  expect(task, `${actor.name} 没有待办`).toBeDefined();
  return task!;
}

/** 用真实授权器办理（办理上限 = 办理人当时的字段权限；w.decide 走放行授权器，上限为空）。 */
export function realApi(w: World) {
  return tenantApi(w.db, { authorize: undefined, clock: w.clock });
}
export async function handleReal(
  w: World,
  view: InstanceView,
  actor: Person,
  action: 'approve' | 'disagree' | 'reject',
) {
  const task = await pendingTask(w, view, actor);
  const response = await realApi(w).request('POST', `${APPROVAL}/tasks/${task.id}/${action}`, {
    ...w.as(actor.userId),
    ifMatch: view.revision,
    body: { comment: '合成意见' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

// 响应体形状由实现决定，测试按键名断言，故用宽松对象
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
export interface Reader {
  readonly status: number;
  readonly body: Json;
  readonly text: string;
}
async function read(response: Response): Promise<Reader> {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : {} };
}

/** 路径 1：审批中心 GET /approval/instances/:id。 */
export async function center(w: World, instanceId: string, userId: string, real = false): Promise<Reader> {
  const api = real ? realApi(w) : undefined;
  const response = api
    ? await api.request('GET', `${APPROVAL}/instances/${instanceId}`, w.as(userId))
    : await w.request(userId, 'GET', `${APPROVAL}/instances/${instanceId}`);
  return read(response);
}
/** 路径 2：单 Offer 详情 GET /offers/:id（与审批中心不是同一接口）。 */
export async function offerDetail(w: World, offerId: string, userId: string, real = false): Promise<Reader> {
  const api = real ? realApi(w) : undefined;
  const response = api
    ? await api.request('GET', `${OFFERS}/${offerId}`, w.as(userId))
    : await w.request(userId, 'GET', `${OFFERS}/${offerId}`);
  return read(response);
}

/** 单 Offer：提交 → 部门负责人驳回（回到可编辑）。返回办理那一刻的 Offer 现值（含各名称）。 */
export async function handledSingle(w: World, via: 'allow' | 'real' = 'allow') {
  const offer = await createOffer(w, NAME_A1);
  await w.json(await w.submitRaw(offer));
  const view = await w.instance(offer.id);
  const atHandling = await w.get(offer.id);
  if (via === 'real') await handleReal(w, view, w.head, 'reject');
  else await w.decide(view, w.head, 'reject');
  return { offer, instanceId: view.id, atHandling };
}

/** 事后：申请人把地点 / 薪资 / 姓名 / 录用部门都改了。返回新部门 ID。 */
export async function changeSingle(w: World, id: string) {
  const other = await w.org(`ZZ_事后部门${randomUUID().replace(/-/g, '').slice(0, 12)}`);
  await editOffer(w, id, { workPlace: PLACE_B, salaryAfterRegular: SALARY_B, name: NAME_B1, departmentId: other });
  return other;
}

/** Offer 批：两份 Offer 提交 → 直接上级不同意（子项回到可编辑）。 */
export async function handledBatch(w: World, via: 'allow' | 'real' = 'allow') {
  const a = await createOffer(w, NAME_A1);
  const b = await createOffer(w, NAME_A2, { salaryAfterRegular: 7000, workPlace: 'ZZ_乙地点' });
  const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [a.id, b.id], remark: 'ZZ_批备注' }), 201);
  const view = await w.instance(batch.id);
  const atHandling = [await w.get(a.id), await w.get(b.id)];
  if (via === 'real') await handleReal(w, view, w.manager, 'disagree');
  else await w.decide(view, w.manager, 'disagree');
  return { a, b, batchId: batch.id, instanceId: view.id, atHandling };
}

/** 授予审批人 Offer 对象的字段查看权（返回身份，可再 setView 收窄 / 放宽）。 */
export async function offerViewer(
  w: World,
  userId: string,
  view: readonly string[] = OFFER_FIELD_CODES,
  definition: ObjectDefinition = MODULE_OBJECTS.offer,
) {
  const world = await permissionAdmin(w.apv);
  const profile = await grantFieldAccess(world, userId, { view }, definition);
  return { world, profile };
}

export const rowsOfBatch = (body: Json) => (body.form?.values?.offers ?? []) as Json[];

/** 夹具直写：绕过审批改批的成员（删 / 增 / 重排），模拟事后成员变化；成员表对租户路径角色只读，故走属主事务。 */
export async function rewriteBatchMembers(w: World, batchId: string, offerIds: readonly string[]) {
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`DELETE FROM offer_batch_approval_items WHERE tenant_id = ${w.tenant.id}
      AND batch_id = ${batchId}::uuid`);
    for (const [index, offerId] of offerIds.entries())
      await tx.execute(sql`INSERT INTO offer_batch_approval_items (tenant_id, batch_id, offer_id, seq)
        VALUES (${w.tenant.id}, ${batchId}::uuid, ${offerId}::uuid, ${index + 1})`);
  });
}

/**
 * 夹具直写：破坏办理份，模拟缺份 / 份残缺。ext = 去掉整个扩展；firstBatchRow = 只去掉批扩展第一行的标签条目；
 * badCeiling = 批扩展的行内列上限改成非数组。触发器放行仅限本事务，不属于业务路径。
 */
export type CopyDamage = 'ext' | 'firstBatchRow' | 'badCeiling';
const DAMAGE = {
  ext: sql`content - 'ext'`,
  firstBatchRow: sql`content #- '{ext,rows,0}'`,
  badCeiling: sql`jsonb_set(content, '{ext,rowCeiling}', '"departmentId"'::jsonb)`,
} as const;
export async function stripExt(w: World, actorUserId: string, part: CopyDamage = 'ext') {
  const content = DAMAGE[part];
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
    await tx.execute(sql`UPDATE approval_handling_contents SET content = ${content}
      WHERE actor_user_id = ${actorUserId}::uuid`);
    await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
  });
}

/** 可信夹具：给组织追加一条只改名称的版本（同 AC-APV setOrgRoles 的追加方式），模拟办理后部门改名。 */
export async function renameOrg(w: World, orgId: string, name: string) {
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
      .values({ ...old!, id: versionId, versionNo: old!.versionNo + 1, previousVersionId: old!.id, name });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
  });
}

/**
 * 可信夹具：照某实例复制 count 条更晚创建、已作废的实例（同一业务对象、同一发起人，没有任务与日志），
 * 把真实办理所在实例挤出「最新 200 条」展示窗口（F-476 P6 评审 P2-1）。
 */
export async function laterInstances(w: World, instanceId: string, count: number) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`INSERT INTO approval_instances
      SELECT (jsonb_populate_record(NULL::approval_instances, to_jsonb(i) || jsonb_build_object(
        'id', gen_random_uuid(), 'status', 'cancelled', 'created_at', i.created_at + g * interval '1 second'))).*
      FROM approval_instances i, generate_series(1, ${count}) g
      WHERE i.tenant_id = ${w.tenant.id} AND i.id = ${instanceId}::uuid`);
  });
}
