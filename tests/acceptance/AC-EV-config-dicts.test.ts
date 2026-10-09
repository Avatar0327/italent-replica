/**
 * R3-T02 PR-B B1a：评定模块底座 + 活动类型（`TEvaluation.ActivityType`；设计 §3.2、§5.1、§8；拆分方案第 4 节 B1a、第 13 节）。
 * 本文件是 `AC-EV-config-dicts` 的活动类型部分（周期、通用评分项部分由 B1b 复用同一注册器后补）。真实授权器：
 * - CRUD：新建缺省值、列表排序与 `enabled` 过滤、详情、局部修改、删除；无“同步任职记录”（DEC-025）；
 * - 并发与幂等（DEC-067）：缺 If-Match 400、过期 409、同键同内容重放、同键异内容 409；
 * - 字典范围（DEC-121）：看全部 / 创建人 / 空范围，范围在分页前过滤，新建只认看全部；租户隔离；
 * - 权限：数据操作、按钮、字段查看与编辑（含越权改隐藏字段）；
 * - 幂等重放按当前范围与字段权复核（首次与重放都复核）；
 * - 审计与业务写同事务，审计对象 / 动作与目录一致；
 * - 被引用拒删的钩子位（B4 / B5 在此登记引用方）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import {
  type ActivityTypeView,
  creatorOnly,
  errorOf,
  EV_BASE,
  EV_NOW,
  ok,
  operator,
  type Operator,
} from './AC-EV-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const PATH = '/activity-types';
const name = (label = '类型') => `${label}${randomUUID().slice(0, 6)}`;

interface Page {
  readonly page: number;
  readonly pageSize: number;
  readonly hasDataPermission: boolean;
  readonly items: Partial<ActivityTypeView>[];
}

describe('AC-EV-config-dicts 活动类型', () => {
  /** 缺省企业策略：字典只认身份级看全部，没有创建人维度。 */
  let world: PermissionWorld;
  /** 企业范围策略改为只认“使用用户”维度（创建人）：撤销看全部后只剩自己建的。 */
  let creatorWorld: PermissionWorld;
  const seedWorld = async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    return { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock: () => EV_NOW }) };
  };
  beforeAll(async () => {
    world = await seedWorld();
    creatorWorld = await seedWorld();
    await creatorOnly(creatorWorld, 'activityType');
  });

  const create = (op: Operator, extra: Record<string, unknown> = {}) =>
    op.request('POST', PATH, { ifMatch: 0, body: { name: name(), ...extra } });
  const created = (op: Operator, extra: Record<string, unknown> = {}) =>
    create(op, extra).then((r) => ok<ActivityTypeView>(r, 201));
  const list = async (op: Operator, query = '') =>
    ok<Page>(await op.request('GET', `${PATH}${query ? `?${query}` : ''}`));
  const detailStatus = async (op: Operator, id: string) => (await op.request('GET', `${PATH}/${id}`)).status;
  const admin = () => operator(world, { seeAll: true, auditor: true });

  describe('CRUD', () => {
    it('新建缺省值、详情、局部修改、删除；没有“同步任职记录”（DEC-025）', async () => {
      const op = await admin();
      const made = await created(op, {});
      expect(made).toMatchObject({ revision: 1, displayOrder: 0, enabled: true, syncQualification: false });
      expect(made.createdBy).toBe(op.userId);
      expect(made).not.toHaveProperty('syncEmploymentRecord');

      const read = await ok<ActivityTypeView>(await op.request('GET', `${PATH}/${made.id}`));
      expect(read).toEqual(made);

      const patched = await ok<ActivityTypeView>(
        await op.request('PATCH', `${PATH}/${made.id}`, {
          ifMatch: made.revision,
          body: { syncQualification: true, displayOrder: 3 },
        }),
      );
      expect(patched).toMatchObject({
        revision: 2,
        name: made.name,
        enabled: true,
        syncQualification: true,
        displayOrder: 3,
      });
      expect(await ok<ActivityTypeView>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(patched);

      await ok(await op.request('DELETE', `${PATH}/${made.id}`, { ifMatch: patched.revision }));
      expect(await detailStatus(op, made.id)).toBe(404);
    });

    it('列表按顺序号、名称排序，`enabled` 过滤，分页参数非法 400', async () => {
      const op = await admin();
      const label = name('排序');
      const b = await created(op, { name: `${label}-3`, displayOrder: 2 });
      const a = await created(op, { name: `${label}-1`, displayOrder: 1 });
      const off = await created(op, { name: `${label}-2`, displayOrder: 1, enabled: false });
      const mine = (page: Page) => page.items.filter((item) => item.name?.startsWith(label)).map((item) => item.id);
      expect(mine(await list(op, 'pageSize=100'))).toEqual([a.id, off.id, b.id]);
      expect(mine(await list(op, 'pageSize=100&enabled=false'))).toEqual([off.id]);
      expect(mine(await list(op, 'pageSize=100&enabled=true'))).toEqual([a.id, b.id]);
      expect((await op.request('GET', `${PATH}?enabled=maybe`)).status).toBe(400);
      expect((await op.request('GET', `${PATH}/not-a-uuid`)).status).toBe(400);
    });

    it('请求体结构：未登记的键、空名称、超长名称、类型不符都是 400，数据不变', async () => {
      const op = await admin();
      const made = await created(op);
      const bad: Record<string, unknown>[] = [
        { name: '' },
        { name: 'x'.repeat(101) },
        { name: name(), syncEmploymentRecord: true },
        { name: name(), ownerOrgId: randomUUID() },
        { name: name(), enabled: 'yes' },
        { name: name(), displayOrder: -1 },
      ];
      for (const body of bad) {
        const response = await op.request('POST', PATH, { ifMatch: 0, body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      const patch = await op.request('PATCH', `${PATH}/${made.id}`, {
        ifMatch: made.revision,
        body: { id: randomUUID() },
      });
      expect(patch.status).toBe(400);
      expect(await ok<ActivityTypeView>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(made);
    });
  });

  describe('并发与幂等（DEC-067）', () => {
    it('缺 If-Match 400、过期 409 且数据不变；新建带非 0 的 If-Match 409；缺幂等键 400', async () => {
      const op = await admin();
      const made = await created(op);
      const missing = await op.request('PATCH', `${PATH}/${made.id}`, { body: { name: name() } });
      expect(missing.status).toBe(400);
      expect((await errorOf(missing)).code).toBe('REVISION_REQUIRED');

      const stale = await op.request('PATCH', `${PATH}/${made.id}`, { ifMatch: 7, body: { name: name() } });
      expect(stale.status).toBe(409);
      expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
      expect(await ok<ActivityTypeView>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(made);

      const nonZero = await op.request('POST', PATH, { ifMatch: 3, body: { name: name() } });
      expect(nonZero.status).toBe(409);

      const noKey = await op.request('POST', PATH, { ifMatch: 0, idempotencyKey: null, body: { name: name() } });
      expect(noKey.status).toBe(400);
      expect((await errorOf(noKey)).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('同键同内容重放返回原结果且不重复写；同键异内容 409', async () => {
      const op = await admin();
      const idempotencyKey = randomUUID();
      const body = { name: name('幂等') };
      const first = await ok<ActivityTypeView>(
        await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body }),
        201,
      );
      const replay = await ok<ActivityTypeView>(
        await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body }),
        201,
      );
      expect(replay).toEqual(first);
      expect((await list(op, 'pageSize=100')).items.filter((item) => item.name === body.name)).toHaveLength(1);

      const other = await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body: { name: name('幂等') } });
      expect(other.status).toBe(409);
      expect((await errorOf(other)).code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('字典范围（DEC-121：看全部 ∪ 创建人；新建只认看全部；范围在分页前过滤）', () => {
    it('空范围：列表为空且 hasDataPermission=false，详情 404，新建 404，修改 / 删除 404', async () => {
      const seeAll = await admin();
      const row = await created(seeAll);
      const empty = await operator(world, {});
      const page = await list(empty, 'pageSize=100');
      expect(page).toMatchObject({ items: [], hasDataPermission: false });
      expect(await detailStatus(empty, row.id)).toBe(404);
      expect((await create(empty)).status).toBe(404);
      expect(
        (await empty.request('PATCH', `${PATH}/${row.id}`, { ifMatch: row.revision, body: { name: name() } })).status,
      ).toBe(404);
      expect((await empty.request('DELETE', `${PATH}/${row.id}`, { ifMatch: row.revision })).status).toBe(404);
      expect(await ok<ActivityTypeView>(await seeAll.request('GET', `${PATH}/${row.id}`))).toEqual(row);
    });

    it('创建人范围：只看得到、改得动自己建的；别人建的 404，且分页前过滤不占页', async () => {
      const seeAll = await operator(creatorWorld, { seeAll: true, auditor: true });
      const mine = await operator(creatorWorld, { seeAll: true });
      const own = await created(mine, { name: name('自建') });
      const foreign = await created(seeAll, { name: name('他建') });
      await mine.revokeSeeAll();

      const page = await list(mine, 'pageSize=1');
      expect(page.hasDataPermission).toBe(true);
      expect(page.items.map((item) => item.id)).toEqual([own.id]);
      expect(await detailStatus(mine, own.id)).toBe(200);
      expect(await detailStatus(mine, foreign.id)).toBe(404);

      const renamed = await ok<ActivityTypeView>(
        await mine.request('PATCH', `${PATH}/${own.id}`, { ifMatch: own.revision, body: { name: name('改名') } }),
      );
      expect(renamed.revision).toBe(own.revision + 1);
      const denied = await mine.request('PATCH', `${PATH}/${foreign.id}`, {
        ifMatch: foreign.revision,
        body: { name: name('越权') },
      });
      expect(denied.status).toBe(404);
      expect((await mine.request('DELETE', `${PATH}/${foreign.id}`, { ifMatch: foreign.revision })).status).toBe(404);
      expect(await ok<ActivityTypeView>(await seeAll.request('GET', `${PATH}/${foreign.id}`))).toEqual(foreign);
      // 新建只认看全部：创建人范围无权新建
      expect((await create(mine)).status).toBe(404);
    });

    it('租户隔离：另一租户的成员读不到、改不了本租户的活动类型', async () => {
      const row = await created(await admin());
      const other = await seedTenantWithMember(testDb().db, 'ev-other');
      const api = tenantApi(testDb().db, { clock: () => EV_NOW });
      const as = { user: other.user.id, tenant: other.tenant.id };
      const read = await api.request('GET', `${EV_BASE}${PATH}/${row.id}`, as);
      expect(read.status).toBe(404);
      const mineList = await api.request('GET', `${EV_BASE}${PATH}?pageSize=100`, as);
      expect(((await ok<Page>(mineList)).items ?? []).some((item) => item.id === row.id)).toBe(false);
      const write = await api.request('PATCH', `${EV_BASE}${PATH}/${row.id}`, {
        ...as,
        ifMatch: row.revision,
        body: { name: name() },
      });
      expect(write.status).toBe(404);
      // 用本租户成员的身份访问另一租户：不是成员，拒绝
      const forged = await api.request('GET', `${EV_BASE}${PATH}`, { user: other.user.id, tenant: world.tenant.id });
      expect([401, 403, 404]).toContain(forged.status);
    });
  });

  describe('权限：数据操作、按钮、字段（含越权改隐藏字段）', () => {
    it('没有对象查看权：列表 / 详情 403；没有新建 / 编辑 / 删除数据操作权各 403', async () => {
      const row = await created(await admin());
      const none = await operator(world, { seeAll: true, noObject: ['activityType'] });
      expect((await none.request('GET', PATH)).status).toBe(403);
      expect((await none.request('GET', `${PATH}/${row.id}`)).status).toBe(403);

      const noCreate = await operator(world, { seeAll: true, noCreate: ['activityType'] });
      expect((await create(noCreate)).status).toBe(403);
      const noUpdate = await operator(world, { seeAll: true, noUpdate: ['activityType'] });
      const patch = await noUpdate.request('PATCH', `${PATH}/${row.id}`, {
        ifMatch: row.revision,
        body: { name: name() },
      });
      expect(patch.status).toBe(403);
      const noDelete = await operator(world, { seeAll: true, noDelete: ['activityType'] });
      expect((await noDelete.request('DELETE', `${PATH}/${row.id}`, { ifMatch: row.revision })).status).toBe(403);
      expect(await ok<ActivityTypeView>(await (await admin()).request('GET', `${PATH}/${row.id}`))).toEqual(row);
    });

    it('没有按钮权限：新建 / 编辑 / 删除 403，查看照常', async () => {
      const row = await created(await admin());
      const op = await operator(world, { seeAll: true, noButtons: ['activityType'] });
      expect((await create(op)).status).toBe(403);
      expect(
        (await op.request('PATCH', `${PATH}/${row.id}`, { ifMatch: row.revision, body: { name: name() } })).status,
      ).toBe(403);
      expect((await op.request('DELETE', `${PATH}/${row.id}`, { ifMatch: row.revision })).status).toBe(403);
      expect(await detailStatus(op, row.id)).toBe(200);
    });

    it('字段查看权：列表、详情、写入响应都不带隐藏字段，其余字段的值不变', async () => {
      const full = await admin();
      const row = await created(full, { syncQualification: true });
      const op = await operator(world, { seeAll: true, hidden: { activityType: ['syncQualification'] } });
      const shown = (await list(op, 'pageSize=100')).items.find((item) => item.id === row.id)!;
      expect(shown).toMatchObject({ name: row.name, displayOrder: row.displayOrder, enabled: row.enabled });
      expect(shown).not.toHaveProperty('syncQualification');
      const detail = await ok<Partial<ActivityTypeView>>(await op.request('GET', `${PATH}/${row.id}`));
      expect(detail).not.toHaveProperty('syncQualification');
      const made = await ok<Partial<ActivityTypeView>>(await create(op), 201);
      expect(made).not.toHaveProperty('syncQualification');
      const patched = await ok<Partial<ActivityTypeView>>(
        await op.request('PATCH', `${PATH}/${row.id}`, { ifMatch: row.revision, body: { displayOrder: 5 } }),
      );
      expect(patched).toMatchObject({ displayOrder: 5 });
      expect(patched).not.toHaveProperty('syncQualification');
    });

    it('字段编辑权：改只读 / 隐藏字段 403 且数据不变（含布尔值显式写 false）', async () => {
      const full = await admin();
      const row = await created(full, { syncQualification: true });
      const op = await operator(world, {
        seeAll: true,
        readonly: { activityType: ['syncQualification'] },
        hidden: { activityType: ['displayOrder'] },
      });
      const toggle = await op.request('PATCH', `${PATH}/${row.id}`, {
        ifMatch: row.revision,
        body: { syncQualification: false },
      });
      expect(toggle.status).toBe(403);
      expect((await errorOf(toggle)).code).toBe('FORBIDDEN');
      const hidden = await op.request('PATCH', `${PATH}/${row.id}`, {
        ifMatch: row.revision,
        body: { displayOrder: 9 },
      });
      expect(hidden.status).toBe(403);
      const onCreate = await create(op, { syncQualification: false });
      expect(onCreate.status).toBe(403);
      expect(await ok<ActivityTypeView>(await full.request('GET', `${PATH}/${row.id}`))).toEqual(row);
      // 能编辑的字段照常
      await ok(await op.request('PATCH', `${PATH}/${row.id}`, { ifMatch: row.revision, body: { name: name('可改') } }));
    });
  });

  describe('幂等重放按当前范围与字段权复核（首次与重放都复核，DEC-067）', () => {
    it('新建重放：撤销看全部后范围为空 → 404，不返回结果对象；数据照常保留', async () => {
      const op = await operator(world, { seeAll: true });
      const idempotencyKey = randomUUID();
      const body = { name: name('撤权重放') };
      const first = await ok<ActivityTypeView>(
        await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body }),
        201,
      );
      await op.revokeSeeAll();
      const replay = await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body });
      expect(replay.status).toBe(404);
      expect(await errorOf(replay)).toMatchObject({ code: 'NOT_FOUND' });
      expect(await ok<ActivityTypeView>(await (await admin()).request('GET', `${PATH}/${first.id}`))).toEqual(first);
    });

    it('新建重放：创建人范围内结果对象仍可见 → 返回原结果', async () => {
      const op = await operator(creatorWorld, { seeAll: true });
      const idempotencyKey = randomUUID();
      const body = { name: name('创建人重放') };
      const first = await ok<ActivityTypeView>(
        await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body }),
        201,
      );
      await op.revokeSeeAll();
      const replay = await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(first);
    });

    it('修改重放：首次成功后隐藏字段，重放响应按当前字段权裁剪', async () => {
      const op = await operator(world, { seeAll: true });
      const row = await created(op, { syncQualification: true });
      const idempotencyKey = randomUUID();
      const options = { ifMatch: row.revision, idempotencyKey, body: { displayOrder: 4 } };
      const first = await ok<ActivityTypeView>(await op.request('PATCH', `${PATH}/${row.id}`, options));
      expect(first.syncQualification).toBe(true);
      await op.hide('activityType', ['syncQualification']);
      const replay = await ok<Partial<ActivityTypeView>>(await op.request('PATCH', `${PATH}/${row.id}`, options));
      expect(replay).toMatchObject({ id: row.id, displayOrder: 4, revision: first.revision });
      expect(replay).not.toHaveProperty('syncQualification');
    });

    it('删除重放：撤销看全部后按快照的创建人复核——别人建的 404，自己建的照常返回', async () => {
      const other = await operator(creatorWorld, { seeAll: true });
      const mine = await operator(creatorWorld, { seeAll: true });
      const own = await created(mine);
      const foreign = await created(other);
      const ownKey = randomUUID();
      const foreignKey = randomUUID();
      await ok(await mine.request('DELETE', `${PATH}/${own.id}`, { ifMatch: own.revision, idempotencyKey: ownKey }));
      await ok(
        await mine.request('DELETE', `${PATH}/${foreign.id}`, {
          ifMatch: foreign.revision,
          idempotencyKey: foreignKey,
        }),
      );
      await mine.revokeSeeAll();
      const replayOwn = await mine.request('DELETE', `${PATH}/${own.id}`, {
        ifMatch: own.revision,
        idempotencyKey: ownKey,
      });
      expect(replayOwn.status).toBe(200);
      expect(((await replayOwn.json()) as ActivityTypeView).id).toBe(own.id);
      const replayForeign = await mine.request('DELETE', `${PATH}/${foreign.id}`, {
        ifMatch: foreign.revision,
        idempotencyKey: foreignKey,
      });
      expect(replayForeign.status).toBe(404);
    });
  });

  describe('审计（DEC-019 / 216：业务写与审计同事务）', () => {
    it('新建 / 修改 / 删除各一条，动作 evaluation.activity-type.*，前后值对得上字段目录', async () => {
      const op = await admin();
      const made = await created(op, { syncQualification: true });
      const patched = await ok<ActivityTypeView>(
        await op.request('PATCH', `${PATH}/${made.id}`, { ifMatch: made.revision, body: { enabled: false } }),
      );
      await ok(await op.request('DELETE', `${PATH}/${made.id}`, { ifMatch: patched.revision }));

      const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
      const logs = await audit.dataChanges(op.as, { objectType: 'TEvaluation.ActivityType', limit: '100' });
      const mine = logs.items.filter((item) => item.objectId === made.id);
      expect(mine.map((item) => item.action).sort()).toEqual([
        'evaluation.activity-type.create',
        'evaluation.activity-type.delete',
        'evaluation.activity-type.update',
      ]);
      const update = await audit.dataChange(op.as, mine.find((item) => item.action.endsWith('.update'))!.id);
      expect(update.changes.map((change) => change.field)).toEqual(['enabled']);
      expect(update.changes[0]).toMatchObject({ from: true, to: false });
      const removed = await audit.dataChange(op.as, mine.find((item) => item.action.endsWith('.delete'))!.id);
      expect(removed.before).toMatchObject({ id: made.id, name: made.name, syncQualification: true });
    });

    it('失败的写入不留审计：过期 revision 的修改不产生日志，数据与日志条数前后一致', async () => {
      const op = await admin();
      const made = await created(op);
      const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
      const count = async () =>
        (await audit.dataChanges(op.as, { objectType: 'TEvaluation.ActivityType', limit: '100' })).items.filter(
          (item) => item.objectId === made.id,
        ).length;
      const before = await count();
      const stale = await op.request('PATCH', `${PATH}/${made.id}`, { ifMatch: 99, body: { name: name() } });
      expect(stale.status).toBe(409);
      expect(await count()).toBe(before);
    });
  });

  describe('被引用拒删的钩子位（B4 / B5 登记引用方）', () => {
    it('登记的引用方命中时删除 409（reason 由引用方给出），数据与审计不变；未命中照常删除', async () => {
      const op = await admin();
      const used = await created(op);
      const free = await created(op);
      const { registerInUse } = await import('../../apps/api/src/modules/evaluation/usage.js');
      registerInUse('activityType', {
        sql: (ctx, id) => sql`SELECT 1 WHERE ${id}::uuid = ${used.id}::uuid AND ${ctx.tenantId}::uuid IS NOT NULL`,
        message: '该活动类型已被评定活动引用，不能删除',
        reason: 'ACTIVITY_TYPE_IN_USE',
      });
      const blocked = await op.request('DELETE', `${PATH}/${used.id}`, { ifMatch: used.revision });
      expect(blocked.status).toBe(409);
      expect(await errorOf(blocked)).toMatchObject({ code: 'CONFLICT', reason: 'ACTIVITY_TYPE_IN_USE' });
      const rows = await withTenant(testDb().db, world.tenant.id, async (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM ev_activity_types WHERE id = ${used.id}::uuid`),
      );
      expect(Number((rows as unknown as { n: number }[])[0]?.n ?? (rows as { rows: { n: number }[] }).rows[0]?.n)).toBe(
        1,
      );
      await ok(await op.request('DELETE', `${PATH}/${free.id}`, { ifMatch: free.revision }));
    });
  });
});
