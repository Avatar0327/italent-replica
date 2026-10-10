/**
 * R3-T02 PR-B B1b：活动周期（`TEvaluation.ActivityCycle`）与通用评分项（`TEvaluation.GeneralScoreItem`）
 * （设计 §3.2、§5.1、§8；拆分方案第 4 节 B1b 行）。本文件是 `AC-EV-config-dicts` 的周期 / 通用评分项部分，复用 B1a 的
 * 通用注册器，两类字典同口径逐项参数化：
 * - CRUD、列表排序 / `enabled` 过滤、严格请求体；
 * - 并发与幂等（DEC-067）；
 * - 字典范围（DEC-121：看全部 ∪ 创建人，新建只认看全部，分页前过滤）与租户隔离；
 * - 数据操作、按钮、字段查看与编辑权（含显式清空）；筛选 / 排序不泄露无查看权的字段；
 * - 重放按当前范围与字段权复核；审计；被引用拒删的钩子位（B4 / B5 登记引用方）。
 * DEC-380（取证 Q-M0-170 / 171，#196，照原站）：名称唯一并给原站提示（周期「活动周期名称已存在，请重新输入」、通用评分项
 * 「名称已存在，请重新输入」）；周期没有描述字段；通用评分项的描述（评价标准）≤500 字；被引用时周期拒绝停用（原站置灰）、通用评分项
 * 拒绝停用并列出引用它的评价表（只列操作人看得到的，其余计为“其他 N 个”，DEC-374⑥）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import {
  creatorOnly,
  errorOf,
  EV_BASE,
  EV_NOW,
  type EvaluationKey,
  ok,
  operator,
  type Operator,
} from './AC-EV-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const name = (label = '字典') => `${label}${randomUUID().slice(0, 6)}`;

interface Row {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly description?: string | null;
  readonly createdBy: string;
}
interface Page {
  readonly hasDataPermission: boolean;
  readonly items: Partial<Row>[];
}

interface Subject {
  readonly key: EvaluationKey;
  readonly label: string;
  readonly path: string;
  readonly table: string;
  readonly objectType: string;
  readonly auditPrefix: string;
  /** 重名提示（DEC-380 照原站）。 */
  readonly nameExists: { readonly reason: string; readonly message: string };
  /** 该对象除 name / enabled 外的可写字段。 */
  readonly extra: Record<string, unknown>;
  /** 可单独隐藏 / 设为只读的非名称字段。 */
  readonly side: string;
  readonly sideValue: unknown;
  readonly otherValue: unknown;
}

const SUBJECTS: readonly Subject[] = [
  {
    key: 'activityCycle',
    label: '活动周期',
    path: '/activity-cycles',
    table: 'ev_cycles',
    objectType: 'TEvaluation.ActivityCycle',
    auditPrefix: 'evaluation.activity-cycle',
    nameExists: { reason: 'ACTIVITY_CYCLE_NAME_EXISTS', message: '活动周期名称已存在，请重新输入' },
    extra: {},
    side: 'enabled',
    sideValue: false,
    otherValue: true,
  },
  {
    key: 'generalScoreItem',
    label: '通用评分项',
    path: '/general-score-items',
    table: 'ev_general_items',
    objectType: 'TEvaluation.GeneralScoreItem',
    auditPrefix: 'evaluation.general-score-item',
    nameExists: { reason: 'GENERAL_SCORE_ITEM_NAME_EXISTS', message: '名称已存在，请重新输入' },
    extra: { description: '现场表现' },
    side: 'description',
    sideValue: '业绩',
    otherValue: '现场表现',
  },
];

describe.each(SUBJECTS)('AC-EV-config-dicts B1b $label', (s) => {
  const PATH = s.path;
  let world: PermissionWorld;
  let creatorWorld: PermissionWorld;
  const seedWorld = async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    return { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock: () => EV_NOW }) };
  };
  beforeAll(async () => {
    world = await seedWorld();
    creatorWorld = await seedWorld();
    await creatorOnly(creatorWorld, s.key);
  });

  const create = (op: Operator, extra: Record<string, unknown> = {}) =>
    op.request('POST', PATH, { ifMatch: 0, body: { name: name(), ...extra } });
  const created = (op: Operator, extra: Record<string, unknown> = {}) => create(op, extra).then((r) => ok<Row>(r, 201));
  const list = async (op: Operator, query = '') =>
    ok<Page>(await op.request('GET', `${PATH}${query ? `?${query}` : ''}`));
  const detailStatus = async (op: Operator, id: string) => (await op.request('GET', `${PATH}/${id}`)).status;
  const admin = () => operator(world, { seeAll: true, auditor: true });
  const patch = (op: Operator, row: Row, body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    op.request('PATCH', `${PATH}/${row.id}`, { ifMatch: row.revision, body, ...extra });

  describe('CRUD', () => {
    it('新建缺省值、详情、局部修改、删除', async () => {
      const op = await admin();
      const made = await created(op, s.extra);
      expect(made).toMatchObject({ revision: 1, enabled: true });
      expect(made.createdBy).toBe(op.userId);
      if (s.key === 'generalScoreItem') expect(made.description).toBe('现场表现');
      expect(await ok<Row>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(made);

      const renamed = name('改名');
      const patched = await ok<Row>(await patch(op, made, { name: renamed, enabled: false }));
      expect(patched).toMatchObject({ revision: 2, name: renamed, enabled: false });
      expect(await ok<Row>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(patched);

      await ok(await op.request('DELETE', `${PATH}/${made.id}`, { ifMatch: patched.revision }));
      expect(await detailStatus(op, made.id)).toBe(404);
    });

    it('列表按名称、主键稳定排序，`enabled` 过滤，参数非法 400', async () => {
      const op = await admin();
      const label = name('排序');
      const c = await created(op, { name: `${label}-c`, ...s.extra });
      const a = await created(op, { name: `${label}-a`, enabled: false, ...s.extra });
      const b = await created(op, { name: `${label}-b`, ...s.extra });
      const mine = (page: Page) => page.items.filter((item) => item.name?.startsWith(label)).map((item) => item.id);
      expect(mine(await list(op, 'pageSize=100'))).toEqual([a.id, b.id, c.id]);
      expect(mine(await list(op, 'pageSize=100&enabled=false'))).toEqual([a.id]);
      expect(mine(await list(op, 'pageSize=100&enabled=true'))).toEqual([b.id, c.id]);
      expect((await op.request('GET', `${PATH}?enabled=maybe`)).status).toBe(400);
      expect((await op.request('GET', `${PATH}/not-a-uuid`)).status).toBe(400);
    });

    it('请求体结构：未登记的键、空名称、超长名称、类型不符都是 400，数据不变', async () => {
      const op = await admin();
      const made = await created(op, s.extra);
      const bad: Record<string, unknown>[] = [
        { name: '' },
        { name: 'x'.repeat(101) },
        { name: name(), ownerOrgId: randomUUID() },
        { name: name(), displayOrder: 1 },
        { name: name(), enabled: 'yes' },
      ];
      if (s.key === 'generalScoreItem') bad.push({ name: name(), description: 'y'.repeat(501) });
      for (const body of bad) {
        const response = await op.request('POST', PATH, { ifMatch: 0, body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect((await patch(op, made, { id: randomUUID() })).status).toBe(400);
      expect(await ok<Row>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(made);
    });

    it('通用评分项的评价标准最多 500 字：500 字可以保存，501 字 400 并提示“最多输入500个字”，数据不变', async () => {
      if (s.key === 'activityCycle') return;
      const op = await admin();
      const row = await created(op, { description: 'y'.repeat(500) });
      expect(row.description).toHaveLength(500);
      const tooLong = await patch(op, row, { description: 'y'.repeat(501) });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(await tooLong.json())).toContain('最多输入500个字');
      expect(await ok<Row>(await op.request('GET', `${PATH}/${row.id}`))).toEqual(row);
    });

    it('通用评分项的描述可空、可显式清空；活动周期没有描述字段', async () => {
      const op = await admin();
      if (s.key === 'activityCycle') {
        expect((await create(op, { description: '多余' })).status).toBe(400);
        return;
      }
      const plain = await created(op);
      expect(plain.description ?? null).toBeNull();
      const withText = await created(op, { description: '有描述' });
      const cleared = await ok<Row>(await patch(op, withText, { description: null }));
      expect(cleared.description ?? null).toBeNull();
    });
  });

  describe('并发与幂等（DEC-067）', () => {
    it('缺 If-Match 400、过期 409 且数据不变；新建非 0 的 If-Match 409；缺幂等键 400', async () => {
      const op = await admin();
      const made = await created(op, s.extra);
      const missing = await op.request('PATCH', `${PATH}/${made.id}`, { body: { name: name() } });
      expect(missing.status).toBe(400);
      expect((await errorOf(missing)).code).toBe('REVISION_REQUIRED');
      const stale = await op.request('PATCH', `${PATH}/${made.id}`, { ifMatch: 7, body: { name: name() } });
      expect(stale.status).toBe(409);
      expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
      expect(await ok<Row>(await op.request('GET', `${PATH}/${made.id}`))).toEqual(made);
      expect((await op.request('POST', PATH, { ifMatch: 3, body: { name: name() } })).status).toBe(409);
      const noKey = await op.request('POST', PATH, { ifMatch: 0, idempotencyKey: null, body: { name: name() } });
      expect(noKey.status).toBe(400);
      expect((await errorOf(noKey)).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('同键同内容重放返回原结果且不重复写；同键异内容 409', async () => {
      const op = await admin();
      const idempotencyKey = randomUUID();
      const body = { name: name('幂等'), ...s.extra };
      const first = await ok<Row>(await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body }), 201);
      const replay = await ok<Row>(await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body }), 201);
      expect(replay).toEqual(first);
      expect((await list(op, 'pageSize=100')).items.filter((item) => item.name === body.name)).toHaveLength(1);
      const other = await op.request('POST', PATH, { ifMatch: 0, idempotencyKey, body: { name: name('幂等') } });
      expect(other.status).toBe(409);
      expect((await errorOf(other)).code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('字典范围（DEC-121：看全部 ∪ 创建人；新建只认看全部；分页前过滤）与租户隔离', () => {
    it('空范围：列表为空且 hasDataPermission=false，详情 / 新建 / 修改 / 删除 404', async () => {
      const seeAll = await admin();
      const row = await created(seeAll, s.extra);
      const empty = await operator(world, {});
      expect(await list(empty, 'pageSize=100')).toMatchObject({ items: [], hasDataPermission: false });
      expect(await detailStatus(empty, row.id)).toBe(404);
      expect((await create(empty)).status).toBe(404);
      expect((await patch(empty, row, { name: name() })).status).toBe(404);
      expect((await empty.request('DELETE', `${PATH}/${row.id}`, { ifMatch: row.revision })).status).toBe(404);
      expect(await ok<Row>(await seeAll.request('GET', `${PATH}/${row.id}`))).toEqual(row);
    });

    it('创建人范围：只看得到、改得动（含改名）自己建的；别人建的 404，分页前过滤不占页；不能新建', async () => {
      const seeAll = await operator(creatorWorld, { seeAll: true });
      const mine = await operator(creatorWorld, { seeAll: true });
      const own = await created(mine, { name: name('自建'), ...s.extra });
      const foreign = await created(seeAll, { name: name('他建'), ...s.extra });
      await mine.revokeSeeAll();
      const page = await list(mine, 'pageSize=1');
      expect(page.hasDataPermission).toBe(true);
      expect(page.items.map((item) => item.id)).toEqual([own.id]);
      expect(await detailStatus(mine, own.id)).toBe(200);
      expect(await detailStatus(mine, foreign.id)).toBe(404);
      const renamed = await ok<Row>(await patch(mine, own, { name: name('改名') }));
      expect(renamed.revision).toBe(own.revision + 1);
      expect((await patch(mine, foreign, { name: name('越权') })).status).toBe(404);
      expect((await mine.request('DELETE', `${PATH}/${foreign.id}`, { ifMatch: foreign.revision })).status).toBe(404);
      expect(await ok<Row>(await seeAll.request('GET', `${PATH}/${foreign.id}`))).toEqual(foreign);
      expect((await create(mine)).status).toBe(404);
    });

    it('租户隔离：另一租户的成员读不到、改不了', async () => {
      const row = await created(await admin(), s.extra);
      const other = await seedTenantWithMember(testDb().db, 'ev-b1b-other');
      const api = tenantApi(testDb().db, { clock: () => EV_NOW });
      const as = { user: other.user.id, tenant: other.tenant.id };
      expect((await api.request('GET', `${EV_BASE}${PATH}/${row.id}`, as)).status).toBe(404);
      const others = await ok<Page>(await api.request('GET', `${EV_BASE}${PATH}?pageSize=100`, as));
      expect(others.items.some((item) => item.id === row.id)).toBe(false);
      const write = await api.request('PATCH', `${EV_BASE}${PATH}/${row.id}`, {
        ...as,
        ifMatch: row.revision,
        body: { name: name() },
      });
      expect(write.status).toBe(404);
    });
  });

  describe('权限：数据操作、按钮、字段（含显式清空）', () => {
    it('没有对象查看权 403；没有新建 / 编辑 / 删除数据操作权各 403；没有按钮 403，查看照常', async () => {
      const row = await created(await admin(), s.extra);
      const none = await operator(world, { seeAll: true, noObject: [s.key] });
      expect((await none.request('GET', PATH)).status).toBe(403);
      expect((await none.request('GET', `${PATH}/${row.id}`)).status).toBe(403);
      expect((await create(await operator(world, { seeAll: true, noCreate: [s.key] }))).status).toBe(403);
      const noUpdate = await operator(world, { seeAll: true, noUpdate: [s.key] });
      expect((await patch(noUpdate, row, { name: name() })).status).toBe(403);
      const noDelete = await operator(world, { seeAll: true, noDelete: [s.key] });
      expect((await noDelete.request('DELETE', `${PATH}/${row.id}`, { ifMatch: row.revision })).status).toBe(403);
      const noButtons = await operator(world, { seeAll: true, noButtons: [s.key] });
      expect((await create(noButtons)).status).toBe(403);
      expect((await patch(noButtons, row, { name: name() })).status).toBe(403);
      expect((await noButtons.request('DELETE', `${PATH}/${row.id}`, { ifMatch: row.revision })).status).toBe(403);
      expect(await detailStatus(noButtons, row.id)).toBe(200);
      expect(await ok<Row>(await (await admin()).request('GET', `${PATH}/${row.id}`))).toEqual(row);
    });

    it('字段查看权：列表、详情、写入响应都不带隐藏字段，其余字段的值不变', async () => {
      const row = await created(await admin(), s.extra);
      const op = await operator(world, { seeAll: true, hidden: { [s.key]: [s.side] } });
      const shown = (await list(op, 'pageSize=100')).items.find((item) => item.id === row.id)!;
      expect(shown.name).toBe(row.name);
      expect(shown).not.toHaveProperty(s.side);
      expect(await ok<object>(await op.request('GET', `${PATH}/${row.id}`))).not.toHaveProperty(s.side);
      expect(await ok<object>(await create(op), 201)).not.toHaveProperty(s.side);
      const renamed = await ok<Partial<Row>>(await patch(op, row, { name: name('只改名') }));
      expect(renamed).not.toHaveProperty(s.side);
    });

    it('字段编辑权：改只读 / 隐藏字段 403 且数据不变（含布尔 false 与显式清空 null）', async () => {
      const full = await admin();
      const row = await created(full, s.extra);
      const op = await operator(world, { seeAll: true, readonly: { [s.key]: [s.side] } });
      const touch = await patch(op, row, { [s.side]: s.sideValue });
      expect(touch.status).toBe(403);
      expect((await errorOf(touch)).code).toBe('FORBIDDEN');
      if (s.key === 'generalScoreItem') {
        expect((await patch(op, row, { description: null })).status).toBe(403);
        expect((await create(op, { description: '新建带描述' })).status).toBe(403);
      }
      expect(await ok<Row>(await full.request('GET', `${PATH}/${row.id}`))).toEqual(row);
      await ok(await patch(op, row, { name: name('可改') }));
    });

    it('没有 enabled 查看权：?enabled= 筛选 403 FILTER_FIELD_HIDDEN（true / false 都是）；没有名称查看权时只按主键排序', async () => {
      const full = await admin();
      await created(full, s.extra);
      const blind = await operator(world, { seeAll: true, hidden: { [s.key]: ['enabled'] } });
      for (const value of ['true', 'false']) {
        const response = await blind.request('GET', `${PATH}?enabled=${value}&pageSize=100`);
        expect(response.status, value).toBe(403);
        expect(await errorOf(response)).toEqual({ code: 'FORBIDDEN', reason: 'FILTER_FIELD_HIDDEN' });
      }
      expect((await list(blind, 'pageSize=100')).items.length).toBeGreaterThan(0);
      const nameless = await operator(world, { seeAll: true, hidden: { [s.key]: ['name'] } });
      const ids = (await list(nameless, 'pageSize=100')).items.map((item) => item.id as string);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual([...ids].sort());
    });
  });

  describe('幂等重放按当前范围与字段权复核（首次与重放都复核，DEC-067）', () => {
    it('新建重放：撤销看全部后范围为空 → 404；创建人范围内仍可见 → 原结果', async () => {
      const gone = await operator(world, { seeAll: true });
      const key = randomUUID();
      const body = { name: name('撤权重放'), ...s.extra };
      await ok(await gone.request('POST', PATH, { ifMatch: 0, idempotencyKey: key, body }), 201);
      await gone.revokeSeeAll();
      expect((await gone.request('POST', PATH, { ifMatch: 0, idempotencyKey: key, body })).status).toBe(404);

      const keep = await operator(creatorWorld, { seeAll: true });
      const keepKey = randomUUID();
      const first = await ok<Row>(await keep.request('POST', PATH, { ifMatch: 0, idempotencyKey: keepKey, body }), 201);
      await keep.revokeSeeAll();
      const replay = await keep.request('POST', PATH, { ifMatch: 0, idempotencyKey: keepKey, body });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(first);
    });

    it('修改重放：首次成功后隐藏字段，重放响应按当前字段权裁剪', async () => {
      const op = await operator(world, { seeAll: true });
      const row = await created(op, s.extra);
      const options = { ifMatch: row.revision, idempotencyKey: randomUUID(), body: { name: name('重放改名') } };
      const first = await ok<Row>(await op.request('PATCH', `${PATH}/${row.id}`, options));
      expect(first).toHaveProperty(s.side);
      await op.hide(s.key, [s.side]);
      const replay = await ok<Partial<Row>>(await op.request('PATCH', `${PATH}/${row.id}`, options));
      expect(replay).toMatchObject({ id: row.id, name: options.body.name, revision: first.revision });
      expect(replay).not.toHaveProperty(s.side);
    });

    it('删除重放：撤销看全部后按快照的创建人复核——别人建的 404，自己建的照常返回', async () => {
      const other = await operator(creatorWorld, { seeAll: true });
      const mine = await operator(creatorWorld, { seeAll: true });
      const own = await created(mine, s.extra);
      const foreign = await created(other, s.extra);
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
      expect(((await replayOwn.json()) as Row).id).toBe(own.id);
      const replayForeign = await mine.request('DELETE', `${PATH}/${foreign.id}`, {
        ifMatch: foreign.revision,
        idempotencyKey: foreignKey,
      });
      expect(replayForeign.status).toBe(404);
    });
  });

  describe('审计（DEC-019 / 216：业务写与审计同事务）', () => {
    it(`新建 / 修改 / 删除各一条，动作 ${s.auditPrefix}.*，失败的写入不留审计`, async () => {
      const op = await admin();
      const made = await created(op, s.extra);
      const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
      const logsOf = async () =>
        (await audit.dataChanges(op.as, { objectType: s.objectType, limit: '100' })).items.filter(
          (item) => item.objectId === made.id,
        );
      const stale = await op.request('PATCH', `${PATH}/${made.id}`, { ifMatch: 99, body: { name: name() } });
      expect(stale.status).toBe(409);
      expect(await logsOf()).toHaveLength(1);
      const patched = await ok<Row>(await patch(op, made, { enabled: false }));
      await ok(await op.request('DELETE', `${PATH}/${made.id}`, { ifMatch: patched.revision }));
      const mine = await logsOf();
      expect(mine.map((item) => item.action).sort()).toEqual([
        `${s.auditPrefix}.create`,
        `${s.auditPrefix}.delete`,
        `${s.auditPrefix}.update`,
      ]);
      const update = await audit.dataChange(op.as, mine.find((item) => item.action.endsWith('.update'))!.id);
      expect(update.changes.map((change) => change.field)).toEqual(['enabled']);
      const removed = await audit.dataChange(op.as, mine.find((item) => item.action.endsWith('.delete'))!.id);
      expect(removed.before).toMatchObject({ id: made.id, name: made.name });
    });
  });

  describe('名称唯一（DEC-380，照原站提示）', () => {
    const duplicate = async (op: Operator, response: Response) => {
      expect(response.status).toBe(409);
      const body = (await response.clone().json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({ code: 'CONFLICT', message: s.nameExists.message });
      expect((await errorOf(response)).reason).toBe(s.nameExists.reason);
    };

    it('新建撞名 409：专用 reason + 原站提示原文，首尾空白按 trim 后比较；大小写区分；不同租户可重名；数据不变', async () => {
      const op = await admin();
      const label = name('撞名');
      const first = await created(op, { name: label, ...s.extra });
      await duplicate(op, await create(op, { name: label }));
      await duplicate(op, await create(op, { name: `  ${label}  ` }));
      await created(op, { name: label.toUpperCase() === label ? `${label}x` : label.toUpperCase() });
      const other = await operator(creatorWorld, { seeAll: true });
      await created(other, { name: label });
      expect((await list(op, 'pageSize=100')).items.filter((item) => item.name === label)).toHaveLength(1);
      expect(await ok<Row>(await op.request('GET', `${PATH}/${first.id}`))).toEqual(first);
    });

    it('改名撞名 409 且数据不变；原名保存不算撞名；创建人范围改名撞上范围外的名称也是同一提示（DEC-373③）', async () => {
      const op = await admin();
      const a = await created(op, s.extra);
      const b = await created(op, s.extra);
      await duplicate(op, await patch(op, b, { name: a.name }));
      expect(await ok<Row>(await op.request('GET', `${PATH}/${b.id}`))).toEqual(b);
      await ok(await patch(op, b, { name: b.name, enabled: false }));

      const seeAll = await operator(creatorWorld, { seeAll: true });
      const mine = await operator(creatorWorld, { seeAll: true });
      const own = await created(mine, s.extra);
      const hidden = await created(seeAll, s.extra);
      await mine.revokeSeeAll();
      expect(await detailStatus(mine, hidden.id)).toBe(404);
      await duplicate(mine, await patch(mine, own, { name: hidden.name }));
    });

    it('并发创建同名 / 并发改名到同名：库内唯一约束兜底，只成功一条，另一条同样 409 专用 reason', async () => {
      const op = await admin();
      const label = name('并发');
      const creates = await Promise.all([create(op, { name: label }), create(op, { name: label })]);
      expect(creates.map((r) => r.status).sort()).toEqual([201, 409]);
      await duplicate(
        op,
        creates.find((r) => r.status === 409)!,
      );
      const x = await created(op, s.extra);
      const y = await created(op, s.extra);
      const target = name('并发改名');
      const renames = await Promise.all([patch(op, x, { name: target }), patch(op, y, { name: target })]);
      expect(renames.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  describe('被引用拒停用 / 拒删的钩子位（B4 / B5 登记引用方；DEC-380）', () => {
    it('删除：登记的引用方命中时 409（reason 由引用方给出），数据不变；未命中照常删除', async () => {
      const op = await admin();
      const used = await created(op, s.extra);
      const free = await created(op, s.extra);
      const { registerInUse } = await import('../../apps/api/src/modules/evaluation/usage.js');
      registerInUse(s.key, {
        sql: (ctx, id) => sql`SELECT 1 WHERE ${id}::uuid = ${used.id}::uuid AND ${ctx.tenantId}::uuid IS NOT NULL`,
        message: `该${s.label}已被引用，不能删除`,
        reason: 'DICTIONARY_IN_USE',
      });
      const blocked = await op.request('DELETE', `${PATH}/${used.id}`, { ifMatch: used.revision });
      expect(blocked.status).toBe(409);
      expect(await errorOf(blocked)).toMatchObject({ code: 'CONFLICT', reason: 'DICTIONARY_IN_USE' });
      const count = await withTenant(testDb().db, world.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(s.table)} WHERE id = ${used.id}::uuid`),
      );
      const rows = (Array.isArray(count) ? count : (count as { rows: { n: number }[] }).rows) as { n: number }[];
      expect(Number(rows[0]?.n)).toBe(1);
      await ok(await op.request('DELETE', `${PATH}/${free.id}`, { ifMatch: free.revision }));
    });

    it('停用：只拦 启用 → 停用；命中引用方 409，其他字段修改 / 启用 / 未命中的停用照常；停用规则不拦删除', async () => {
      const op = await admin();
      const used = await created(op, s.extra);
      const free = await created(op, s.extra);
      const { registerInUse } = await import('../../apps/api/src/modules/evaluation/usage.js');
      registerInUse(
        s.key,
        {
          sql: (ctx, id) => sql`SELECT 1 WHERE ${id}::uuid = ${used.id}::uuid AND ${ctx.tenantId}::uuid IS NOT NULL`,
          message: `该${s.label}已被引用，不能停用`,
          reason: 'DICTIONARY_IN_USE_DISABLE',
        },
        'disable',
      );
      const blocked = await patch(op, used, { enabled: false });
      expect(blocked.status).toBe(409);
      expect(await errorOf(blocked)).toMatchObject({ code: 'CONFLICT', reason: 'DICTIONARY_IN_USE_DISABLE' });
      expect(await ok<Row>(await op.request('GET', `${PATH}/${used.id}`))).toEqual(used);
      const renamed = await ok<Row>(await patch(op, used, { name: name('可改名'), enabled: true }));
      expect(renamed.enabled).toBe(true);
      expect((await ok<Row>(await patch(op, free, { enabled: false }))).enabled).toBe(false);
      await ok(await op.request('DELETE', `${PATH}/${renamed.id}`, { ifMatch: renamed.revision }));
    });

    it('通用评分项被评价表引用时拒绝停用并列出引用方：只列操作人看得到的，看不到的计为“其他 N 个”（DEC-374⑥）', async () => {
      if (s.key !== 'generalScoreItem') return;
      const op = await admin();
      const row = await created(op, s.extra);
      const { registerInUse } = await import('../../apps/api/src/modules/evaluation/usage.js');
      registerInUse(
        s.key,
        {
          sql: (ctx, id) => sql`SELECT 1 WHERE ${id}::uuid = ${row.id}::uuid AND ${ctx.tenantId}::uuid IS NOT NULL`,
          message: '此评分项被评价表引用，无法停用',
          reason: 'GENERAL_SCORE_ITEM_IN_USE',
          subject: '此评分项',
          referrerKind: '评价表',
          references: (ctx, id) => sql`SELECT f.id, f.name, f.visible FROM (VALUES
              (${randomUUID()}::uuid, '评价表甲', true), (${randomUUID()}::uuid, '评价表乙', true),
              (${randomUUID()}::uuid, '隐藏表一', false), (${randomUUID()}::uuid, '隐藏表二', false),
              (${randomUUID()}::uuid, '隐藏表三', false)) AS f(id, name, visible)
            WHERE ${id}::uuid = ${row.id}::uuid AND ${ctx.tenantId}::uuid IS NOT NULL`,
        },
        'disable',
      );
      const blocked = await patch(op, row, { enabled: false });
      expect(blocked.status).toBe(409);
      const body = (await blocked.json()) as {
        error: {
          code: string;
          message: string;
          details: { reason: string; referrers: { name: string }[]; otherCount: number };
        };
      };
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toBe('此评分项被评价表【评价表甲、评价表乙】及其他 3 个引用，无法停用');
      expect(body.error.details.reason).toBe('GENERAL_SCORE_ITEM_IN_USE');
      expect(body.error.details.referrers.map((referrer) => referrer.name)).toEqual(['评价表甲', '评价表乙']);
      expect(body.error.details.otherCount).toBe(3);
      expect(JSON.stringify(body)).not.toContain('隐藏表');
    });
  });
});
