/**
 * R3-T02 PR-B B4：评价表（标准模式，`TEvaluation.EvaluationForm`）+ 评分项（设计 §3.2、§5.2 #6；拆分方案第 4 节 B4 行；
 * 规格 24 EV-R3～R5、R40；AC-EV-07 权重纯函数在 B2，这里只验接线）。真实授权器：
 * - 评价表：所属组织必填手选且须在操作人范围内（DEC-082 / DEC-324②），列表 / 详情按所属组织 ∪ 所属人裁剪（分页前），无向下公开；
 * - 评分项：standard ≤ 1 + 任意条 general；通用评分项引用要有字典查看权；权重经 B2 校验；
 * - 隐藏指标 ID 的名称：指标可见 ∧ 名称字段权才给名称，否则只给 ID（§5.2 #6）；
 * - 表单设置 score_mode / full_score / pass_score / total_rule；EV-R5 锁判定函数（本 PR 恒为 false，用注册的假锁验接线）；
 * - 通用评分项被评价表引用：拒删、拒停用并列出可见引用方（DEC-380 / DEC-374⑥，填 B1a / B1b 的钩子位）。
 * 没有编码字段、名称不要求唯一为暂行默认（#216 待取证）。测试计数按 test case 计。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { errorOf, EV_BASE, EV_NOW, ok } from './AC-EV-support.js';
import {
  type FormOperator,
  type FormOperatorOptions,
  formOperator,
  type FormView,
  FORMS,
  formWorld,
  type FormWorld,
  GENERAL_ITEMS,
  type GeneralItem,
  type TargetRef,
} from './AC-EV-form-support.js';
import { registerFormLock } from '../../apps/api/src/modules/evaluation/form-lock.js';

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

interface Page {
  readonly hasDataPermission: boolean;
  readonly items: FormView[];
}

describe('AC-EV-form 评价表（标准模式）', () => {
  let w: FormWorld;
  let g1: GeneralItem;
  let g2: GeneralItem;
  let t1: TargetRef;
  beforeAll(async () => {
    w = (await formWorld(testDb().db)) as FormWorld;
    g1 = await w.generalItem('现场表现');
    g2 = await w.generalItem('业绩贡献');
    t1 = await w.qlTarget('沟通能力');
  });
  afterEach(() => registerFormLock(null));

  const body = (extra: Record<string, unknown> = {}) => ({
    name: `评价表${suffix()}`,
    ownerOrgId: w.orgA,
    scoreMode: 'by_indicator',
    fullScore: 100,
    passScore: 60,
    totalRule: 'weighted',
    items: [
      { kind: 'standard', weight: 80, hiddenTargetIds: [t1.id] },
      { kind: 'general', generalItemId: g1.id, weight: 20 },
    ],
    ...extra,
  });
  const manager = (options: FormOperatorOptions = {}) => formOperator(w, { evOrgs: [w.orgA], ...options });
  const post = (op: FormOperator, data: Record<string, unknown>, extra = {}) =>
    op.request('POST', FORMS, { ifMatch: 0, body: data, ...extra });
  const created = (op: FormOperator, data: Record<string, unknown> = body()) =>
    post(op, data).then((r) => ok<FormView>(r, 201));
  const patch = (op: FormOperator, form: FormView, data: Record<string, unknown>, extra = {}) =>
    op.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: form.revision, body: data, ...extra });
  const read = (op: FormOperator, id: string) => op.request('GET', `${FORMS}/${id}`);
  const adminReads = async (id: string) =>
    (await (await w.setup.request('GET', `${EV_BASE}${FORMS}/${id}`, w.asAdmin)).json()) as FormView;

  describe('CRUD 与表单设置', () => {
    it('新建 / 详情 / 修改 / 删除；评分项按提交顺序；没有 code 字段', async () => {
      const op = await manager();
      const form = await created(op);
      expect(form).toMatchObject({
        revision: 1,
        enabled: true,
        ownerOrgId: w.orgA,
        createdBy: op.userId,
        scoreMode: 'by_indicator',
        fullScore: 100,
        passScore: 60,
        totalRule: 'weighted',
      });
      expect(Object.keys(form)).not.toContain('code');
      expect(form.items.map((item) => item.kind)).toEqual(['standard', 'general']);
      expect(form.items[1]).toMatchObject({ generalItemId: g1.id, name: g1.name, weight: 20 });
      expect(form.items[0]!.hiddenTargets).toEqual([{ id: t1.id, name: t1.name }]);
      expect(await ok<FormView>(await read(op, form.id))).toEqual(form);
      const renamed = await ok<FormView>(await patch(op, form, { name: `改名${suffix()}`, enabled: false }));
      expect(renamed).toMatchObject({ revision: 2, enabled: false });
      expect(renamed.items).toEqual(form.items);
      const swapped = await ok<FormView>(
        await patch(op, renamed, { items: [{ kind: 'general', generalItemId: g2.id, weight: 100 }] }),
      );
      expect(swapped.items.map((item) => item.generalItemId)).toEqual([g2.id]);
      expect(swapped.revision).toBe(3);
      const removed = await op.request('DELETE', `${FORMS}/${form.id}`, { ifMatch: swapped.revision });
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect((await read(op, form.id)).status).toBe(404);
    });

    it('表单设置：评总分只设满分与通过分数（无总分计算规则）；按指标评分必须有总分计算规则；通过分不能超过满分', async () => {
      const op = await manager();
      const total = await created(op, body({ scoreMode: 'by_total', totalRule: undefined, items: [] }));
      expect(total).toMatchObject({ scoreMode: 'by_total', totalRule: null, items: [] });
      const cases: [string, Record<string, unknown>, string][] = [
        ['按指标缺总分规则', { totalRule: undefined }, 'FORM_TOTAL_RULE_REQUIRED'],
        ['评总分带总分规则', { scoreMode: 'by_total', items: [] }, 'FORM_TOTAL_RULE_NOT_ALLOWED'],
        ['通过分超过满分', { passScore: 101 }, 'FORM_PASS_SCORE_EXCEEDS_FULL'],
      ];
      for (const [label, data, reason] of cases) {
        const response = await post(op, body(data));
        expect(response.status, label).toBe(400);
        expect((await errorOf(response)).reason, label).toBe(reason);
      }
      for (const bad of [
        { scoreMode: 'by_vote' },
        { totalRule: 'median' },
        { fullScore: 0 },
        { fullScore: -1 },
        { passScore: -1 },
        { fullScore: 100.123 },
        { fullScore: 1_000_000, passScore: 60 },
        { passScore: 1_000_000 },
        { name: '' },
        { name: 'x'.repeat(101) },
        { code: 'F1' },
        { ownerId: op.userId },
      ]) {
        expect((await post(op, body(bad))).status, JSON.stringify(bad)).toBe(400);
      }
    });

    it('名称不要求唯一；缺省启用；并发与幂等：缺 If-Match 400、过期 409、同键重放不重复写、同键异内容 409', async () => {
      const op = await manager();
      const first = await created(op);
      const same = await created(op, body({ name: first.name }));
      expect(same.name).toBe(first.name);
      const missing = await op.request('PATCH', `${FORMS}/${first.id}`, { body: { name: 'x' } });
      expect(missing.status).toBe(400);
      const stale = await patch(op, { ...first, revision: 9 }, { name: 'y' });
      expect(stale.status).toBe(409);
      expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
      const key = randomUUID();
      const data = body();
      const a = await ok<FormView>(await post(op, data, { idempotencyKey: key }), 201);
      const b = await ok<FormView>(await post(op, data, { idempotencyKey: key }), 201);
      expect(b).toEqual(a);
      const mismatch = await post(op, body(), { idempotencyKey: key });
      expect(mismatch.status).toBe(409);
      expect((await errorOf(mismatch)).code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('评分项：standard ≤ 1，general 任意条；权重经 B2 校验', () => {
    it('standard 第二项 400；general 缺引用 / standard 带引用 / 未知键 400；多个 general 可以', async () => {
      const op = await manager();
      const twoStandards = await post(
        op,
        body({
          items: [
            { kind: 'standard', weight: 50 },
            { kind: 'standard', weight: 50 },
          ],
        }),
      );
      expect(twoStandards.status).toBe(400);
      expect((await errorOf(twoStandards)).reason).toBe('FORM_STANDARD_ITEM_DUPLICATE');
      for (const items of [
        [{ kind: 'general', weight: 10 }],
        [{ kind: 'standard', generalItemId: g1.id }],
        [{ kind: 'general', generalItemId: g1.id, hiddenTargetIds: [t1.id] }],
        [{ kind: 'general', generalItemId: g1.id, extra: 1 }],
        [{ kind: 'other' }],
      ]) {
        expect((await post(op, body({ items }))).status, JSON.stringify(items)).toBe(400);
      }
      const many = await created(
        op,
        body({
          items: [
            { kind: 'general', generalItemId: g1.id, weight: 30 },
            { kind: 'general', generalItemId: g2.id, weight: 30 },
            { kind: 'standard', weight: 40 },
          ],
        }),
      );
      expect(many.items.map((item) => item.kind)).toEqual(['general', 'general', 'standard']);
    });

    it('权重：0～100 的数（最多 2 位小数）或留空；越界 / 非数 / 过多小数 400 WEIGHT_INVALID；留空存 null', async () => {
      const op = await manager();
      for (const weight of [-1, 100.5, 101, 'abc', 33.333]) {
        const response = await post(op, body({ items: [{ kind: 'general', generalItemId: g1.id, weight }] }));
        expect(response.status, String(weight)).toBe(400);
      }
      const blank = await created(op, body({ items: [{ kind: 'general', generalItemId: g1.id }] }));
      expect(blank.items[0]!.weight).toBeNull();
      const edge = await created(
        op,
        body({
          items: [
            { kind: 'standard', weight: 0 },
            { kind: 'general', generalItemId: g1.id, weight: 100 },
          ],
        }),
      );
      expect(edge.items.map((item) => item.weight)).toEqual([0, 100]);
      const bad = await post(op, body({ items: [{ kind: 'general', generalItemId: g1.id, weight: 150 }] }));
      expect((await errorOf(bad)).reason).toBe('WEIGHT_INVALID');
    });

    it('通用评分项引用：没有字典查看权 403；不存在 404；停用的新引用 400，已有引用保留且名称照常；原样提交不重校', async () => {
      const op = await manager();
      const none = await manager({ noGeneralObject: true });
      const denied = await post(none, body());
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect((await errorOf(denied)).reason).toBe('NO_GENERAL_ITEM_ACCESS');
      const missing = await post(op, body({ items: [{ kind: 'general', generalItemId: randomUUID(), weight: 10 }] }));
      expect(missing.status).toBe(404);
      const item = await w.generalItem(`将停用${suffix()}`);
      const form = await created(op, body({ items: [{ kind: 'general', generalItemId: item.id, weight: 10 }] }));
      await w.forceDisableGeneral(item.id);
      const stillShown = await ok<FormView>(await read(op, form.id));
      expect(stillShown.items[0]).toMatchObject({ generalItemId: item.id, name: item.name });
      const same = await ok<FormView>(
        await patch(op, form, { name: `改${suffix()}`, items: stillShown.items.map(sendable) }),
      );
      expect(same.items[0]!.generalItemId).toBe(item.id);
      const fresh = await post(op, body({ items: [{ kind: 'general', generalItemId: item.id, weight: 10 }] }));
      expect(fresh.status).toBe(400);
      expect((await errorOf(fresh)).reason).toBe('REFERENCE_DISABLED');
    });

    it('通用评分项名称：有字典查看权且名称可见才给；看不到字典 / 名称字段只给 ID', async () => {
      const form = await w.adminForm(body());
      const full = await ok<FormView>(await read(await manager(), form.id));
      expect(full.items[1]).toMatchObject({ generalItemId: g1.id, name: g1.name });
      for (const options of [{ noGeneralObject: true }, { hiddenGeneralFields: ['name'] }]) {
        const detail = await ok<FormView>(await read(await manager(options), form.id));
        expect(detail.items[1]).toEqual({ kind: 'general', generalItemId: g1.id, weight: 20 });
        const listed = (
          await ok<Page>(await (await manager(options)).request('GET', `${FORMS}?pageSize=100`))
        ).items.find((item) => item.id === form.id)!;
        expect(listed.items[1]).not.toHaveProperty('name');
      }
    });
  });

  describe('隐藏指标：名称按指标可见 ∧ 名称字段权裁剪（设计 §5.2 #6）', () => {
    it('新增的隐藏指标：没有指标查看权 403；不存在 404；停用 400；原有的保留不重校', async () => {
      const op = await manager();
      const none = await manager({ noTargetObject: true });
      const denied = await post(none, body());
      expect(denied.status, await denied.clone().text()).toBe(403);
      const missing = await post(
        op,
        body({ items: [{ kind: 'standard', weight: 100, hiddenTargetIds: [randomUUID()] }] }),
      );
      expect(missing.status).toBe(404);
      const target = await w.qlTarget(`将停用${suffix()}`);
      const form = await created(
        op,
        body({ items: [{ kind: 'standard', weight: 100, hiddenTargetIds: [target.id] }] }),
      );
      await w.disableTarget(target.id);
      const again = await ok<FormView>(
        await patch(op, form, { items: [{ kind: 'standard', weight: 100, hiddenTargetIds: [target.id] }] }),
      );
      expect(again.items[0]!.hiddenTargets).toEqual([{ id: target.id, name: target.name }]);
      const fresh = await post(op, body({ items: [{ kind: 'standard', weight: 100, hiddenTargetIds: [target.id] }] }));
      expect(fresh.status).toBe(400);
      expect((await errorOf(fresh)).reason).toBe('REFERENCE_DISABLED');
      // 去掉隐藏指标 / 同一指标重复提交都不拦
      const cleared = await ok<FormView>(await patch(op, again, { items: [{ kind: 'standard', weight: 100 }] }));
      expect(cleared.items[0]!.hiddenTargets ?? []).toEqual([]);
    });

    it('名称：指标可见且名称字段可见才给，否则只给 ID（详情、列表、写入响应都一样）', async () => {
      const form = await w.adminForm(body());
      const seen = await ok<FormView>(await read(await manager(), form.id));
      expect(seen.items[0]!.hiddenTargets).toEqual([{ id: t1.id, name: t1.name }]);
      for (const options of [{ noTargetObject: true }, { hiddenTargetFields: ['name'] }]) {
        const op = await manager(options);
        const form = await w.adminForm(body());
        const detail = await ok<FormView>(await read(op, form.id));
        expect(detail.items[0]!.hiddenTargets).toEqual([{ id: t1.id }]);
        const listed = (await ok<Page>(await op.request('GET', `${FORMS}?pageSize=100`))).items.find(
          (item) => item.id === form.id,
        )!;
        expect(listed.items[0]!.hiddenTargets).toEqual([{ id: t1.id }]);
        const written = await ok<FormView>(await patch(op, form, { name: `写后${suffix()}` }));
        expect(written.items[0]!.hiddenTargets).toEqual([{ id: t1.id }]);
        expect(JSON.stringify(written)).not.toContain(t1.name);
      }
    });
  });

  describe('所属组织：必填手选，须在操作人范围内；读写同一谓词，分页前裁剪', () => {
    it('缺所属组织 400；范围外与不存在的组织同为 404；改所属组织到范围外 404，数据不变', async () => {
      const op = await manager();
      const noOrg = body();
      delete (noOrg as Record<string, unknown>)['ownerOrgId'];
      expect((await post(op, noOrg)).status).toBe(400);
      expect((await post(op, body({ ownerOrgId: w.orgB }))).status).toBe(404);
      expect((await post(op, body({ ownerOrgId: randomUUID() }))).status).toBe(404);
      const form = await created(op);
      expect((await patch(op, form, { ownerOrgId: w.orgB })).status).toBe(404);
      expect(await adminReads(form.id)).toMatchObject({ ownerOrgId: w.orgA, revision: form.revision });
    });

    it('所属组织在范围外的评价表：不出现在列表、详情 / 修改 / 删除 404；空范围列表为空；分页不被范围外占位', async () => {
      const inside = await w.adminForm(body());
      const outside = await w.adminForm(body({ ownerOrgId: w.orgB }));
      for (let i = 0; i < 3; i++) await w.adminForm(body({ ownerOrgId: w.orgB }));
      const op = await manager();
      const page = await ok<Page>(await op.request('GET', `${FORMS}?pageSize=100`));
      expect(page.hasDataPermission).toBe(true);
      expect(page.items.map((item) => item.id)).toContain(inside.id);
      expect(page.items.map((item) => item.id)).not.toContain(outside.id);
      const first = await ok<Page>(await op.request('GET', `${FORMS}?page=1&pageSize=1`));
      expect(first.items).toHaveLength(1);
      expect((await read(op, outside.id)).status).toBe(404);
      expect((await patch(op, outside, { name: 'x' })).status).toBe(404);
      expect((await op.request('DELETE', `${FORMS}/${outside.id}`, { ifMatch: outside.revision })).status).toBe(404);
      const empty = await formOperator(w, {});
      expect(await ok<Page>(await empty.request('GET', FORMS))).toMatchObject({ items: [], hasDataPermission: false });
      expect((await post(empty, body())).status).toBe(404);
    });
  });

  describe('权限：数据操作、按钮、字段（含显式清空）', () => {
    it('没有新建 / 编辑 / 删除数据操作权各 403，没有按钮 403，查看照常，数据不变', async () => {
      const form = await w.adminForm(body());
      expect((await post(await manager({ noCreate: true }), body())).status).toBe(403);
      expect((await patch(await manager({ noUpdate: true }), form, { name: 'x' })).status).toBe(403);
      const noDelete = await manager({ noDelete: true });
      expect((await noDelete.request('DELETE', `${FORMS}/${form.id}`, { ifMatch: form.revision })).status).toBe(403);
      const noButtons = await manager({ noButtons: true });
      expect((await post(noButtons, body())).status).toBe(403);
      expect((await patch(noButtons, form, { name: 'x' })).status).toBe(403);
      expect((await read(noButtons, form.id)).status).toBe(200);
      expect(await adminReads(form.id)).toMatchObject({ id: form.id, revision: form.revision });
    });

    it('评分项字段看不到：列表 / 详情 / 写入响应都不带评分项；只读：改评分项 403，改名照常；设置字段只读：改满分 403', async () => {
      const form = await w.adminForm(body());
      const hidden = await manager({ hidden: ['items'] });
      expect(await ok<FormView>(await read(hidden, form.id))).not.toHaveProperty('items');
      const page = await ok<Page>(await hidden.request('GET', `${FORMS}?pageSize=100`));
      for (const item of page.items) expect(item).not.toHaveProperty('items');
      const written = await ok<FormView>(await patch(hidden, form, { name: `名${suffix()}` }));
      expect(written).not.toHaveProperty('items');
      const readonly = await manager({ readonly: ['items', 'fullScore'] });
      expect((await patch(readonly, written, { items: [{ kind: 'standard', weight: 10 }] })).status).toBe(403);
      expect((await patch(readonly, written, { fullScore: 50 })).status).toBe(403);
      const renamed = await ok<FormView>(await patch(readonly, written, { name: `仅改名${suffix()}` }));
      expect(renamed.items).toHaveLength(2);
    });

    it('筛选与排序不泄露：没有 enabled 查看权时 ?enabled= 是 403 FILTER_FIELD_HIDDEN；没有名称查看权时只按主键排序', async () => {
      await w.adminForm(body());
      const blind = await manager({ hidden: ['enabled'] });
      const response = await blind.request('GET', `${FORMS}?enabled=true`);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({ code: 'FORBIDDEN', reason: 'FILTER_FIELD_HIDDEN' });
      const keyed = await manager({ hidden: ['name'] });
      const listed = (await ok<Page>(await keyed.request('GET', `${FORMS}?pageSize=100`))).items.map((item) => item.id);
      expect(listed.length).toBeGreaterThan(1);
      expect(listed).toEqual([...listed].sort());
    });
  });

  describe('隐含的变更也要有字段权（第 1 轮 P2-2）', () => {
    it('切换评分方式会清空总分计算规则：总分计算规则只读 / 隐藏的操作人只改评分方式 → 403，数据不变；显式清空同样 403', async () => {
      const form = await w.adminForm(body());
      for (const options of [{ readonly: ['totalRule'] }, { hidden: ['totalRule'] }]) {
        const op = await manager(options);
        const implicit = await patch(op, form, { scoreMode: 'by_total' });
        expect(implicit.status, JSON.stringify(options)).toBe(403);
        const explicit = await patch(op, form, { scoreMode: 'by_total', totalRule: null });
        expect(explicit.status, JSON.stringify(options)).toBe(403);
        expect(await adminReads(form.id)).toMatchObject({ revision: form.revision, scoreMode: 'by_indicator' });
      }
      // 有总分计算规则编辑权的人：隐含清空照常
      const editor = await manager();
      const cleared = await ok<FormView>(await patch(editor, form, { scoreMode: 'by_total' }));
      expect(cleared).toMatchObject({ scoreMode: 'by_total', totalRule: null });
      // 本来就是评总分、规则没有变化：不需要总分计算规则的编辑权
      const guarded = await manager({ readonly: ['totalRule'] });
      const same = await ok<FormView>(
        await patch(guarded, cleared, { scoreMode: 'by_total', name: `仅改名${suffix()}` }),
      );
      expect(same.totalRule).toBeNull();
    });
  });

  describe('EV-R5 锁判定函数 formLockedByActivities（本 PR 恒为 false，B6 接入）', () => {
    it('缺省不锁：评分相关字段照常可改', async () => {
      const op = await manager();
      const form = await created(op);
      const changed = await ok<FormView>(
        await patch(op, form, { fullScore: 50, passScore: 30, scoreMode: 'by_total', totalRule: null, items: [] }),
      );
      expect(changed).toMatchObject({ scoreMode: 'by_total', fullScore: 50, items: [] });
    });

    it('接线：被锁时评分方式 / 满分 / 通过分数 / 总分规则 / 评分项有变化 → 409 FORM_LOCKED；名称、所属组织、启停与原样提交照常', async () => {
      const op = await manager({ evOrgs: [w.orgA, w.orgB] });
      const form = await created(op);
      registerFormLock(async () => true);
      for (const data of [
        { fullScore: 90 },
        { passScore: 10 },
        { totalRule: 'average' },
        { scoreMode: 'by_total', totalRule: null },
        { items: [{ kind: 'standard', weight: 80 }] },
      ]) {
        const response = await patch(op, form, data);
        expect(response.status, JSON.stringify(data)).toBe(409);
        expect((await errorOf(response)).reason).toBe('FORM_LOCKED');
      }
      expect(await adminReads(form.id)).toMatchObject({ revision: form.revision, fullScore: 100 });
      const ok1 = await ok<FormView>(
        await patch(op, form, {
          name: `锁后改名${suffix()}`,
          enabled: false,
          ownerOrgId: w.orgB,
          fullScore: 100,
          items: form.items.map(sendable),
        }),
      );
      expect(ok1).toMatchObject({ enabled: false, ownerOrgId: w.orgB });
    });
  });

  describe('通用评分项被评价表引用：拒删 / 拒停用（填 B1a / B1b 钩子位，DEC-380 / DEC-374⑥）', () => {
    it('删除被引用的通用评分项 409；评价表删除 / 改引用后可删；不被引用的照常', async () => {
      const item = await w.generalItem(`被引用${suffix()}`);
      const op = await manager();
      const form = await created(op, body({ items: [{ kind: 'general', generalItemId: item.id, weight: 100 }] }));
      const del = () =>
        w.setup.request('DELETE', `${EV_BASE}${GENERAL_ITEMS}/${item.id}`, { ...w.asAdmin, ifMatch: item.revision });
      const refused = await del();
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect((await errorOf(refused)).reason).toBe('GENERAL_SCORE_ITEM_IN_USE');
      await ok(await op.request('DELETE', `${FORMS}/${form.id}`, { ifMatch: form.revision }));
      expect((await del()).status).toBe(200);
      const free = await w.generalItem(`未引用${suffix()}`);
      const gone = await w.setup.request('DELETE', `${EV_BASE}${GENERAL_ITEMS}/${free.id}`, {
        ...w.asAdmin,
        ifMatch: free.revision,
      });
      expect(gone.status).toBe(200);
    });

    it('停用被引用的通用评分项 409，提示列出操作人看得到的评价表并计入“其他 N 个”；未被引用的可停用，不在乎有没有评价表范围', async () => {
      const item = await w.generalItem(`停用${suffix()}`);
      const visible = await w.adminForm(
        body({ name: `可见表${suffix()}`, items: [{ kind: 'general', generalItemId: item.id, weight: 100 }] }),
      );
      const hiddenForm = await w.adminForm(
        body({ ownerOrgId: w.orgB, name: `范围外表${suffix()}`, items: [{ kind: 'general', generalItemId: item.id }] }),
      );
      const op = await manager({ generalWritable: true });
      const response = await op.request('PATCH', `${GENERAL_ITEMS}/${item.id}`, {
        ifMatch: item.revision,
        body: { enabled: false },
      });
      expect(response.status, await response.clone().text()).toBe(409);
      const error = (await response.json()) as {
        error: {
          message: string;
          details: { reason: string; referrers: { id: string; name: string }[]; otherCount: number };
        };
      };
      expect(error.error.details.reason).toBe('GENERAL_SCORE_ITEM_IN_USE');
      expect(error.error.details.referrers).toEqual([{ id: visible.id, name: visible.name }]);
      expect(error.error.details.otherCount).toBe(1);
      expect(error.error.message).toContain(visible.name);
      expect(error.error.message).toContain('及其他 1 个');
      expect(error.error.message).not.toContain(hiddenForm.name);
      const still = await w.setup.request('GET', `${EV_BASE}${GENERAL_ITEMS}/${item.id}`, w.asAdmin);
      expect(((await still.json()) as { enabled: boolean }).enabled).toBe(true);
      // 评价表“名称”字段看不到：提示、明细、排序都不带评价表名称，全部计入“其他 N 个”（第 1 轮 P2-1）
      const blind = await manager({ generalWritable: true, hidden: ['name'] });
      const masked = await blind.request('PATCH', `${GENERAL_ITEMS}/${item.id}`, {
        ifMatch: item.revision,
        body: { enabled: false },
      });
      expect(masked.status, await masked.clone().text()).toBe(409);
      const maskedText = await masked.text();
      expect(maskedText).not.toContain(visible.name);
      expect(maskedText).not.toContain(hiddenForm.name);
      const maskedError = JSON.parse(maskedText) as {
        error: { details: { referrers: unknown[]; otherCount: number } };
      };
      expect(maskedError.error.details.referrers).toEqual([]);
      expect(maskedError.error.details.otherCount).toBe(2);
      const free = await w.generalItem(`可停用${suffix()}`);
      const off = await op.request('PATCH', `${GENERAL_ITEMS}/${free.id}`, {
        ifMatch: free.revision,
        body: { enabled: false },
      });
      expect(off.status, await off.clone().text()).toBe(200);
    });
  });

  describe('审计（DEC-019 / 216：业务写与审计同事务；评分项只存 ID，不冻结名称）', () => {
    it('新建 / 修改 / 删除各一条，动作 evaluation.form.*；前后值含评分项 ID 与权重，不含通用评分项与指标名称', async () => {
      const op = await manager({ auditor: true });
      const form = await created(op);
      const next = await ok<FormView>(await patch(op, form, { passScore: 70 }));
      await ok(await op.request('DELETE', `${FORMS}/${next.id}`, { ifMatch: next.revision }));
      const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
      const logs = (
        await audit.dataChanges(op.as, { objectType: 'TEvaluation.EvaluationForm', limit: '100' })
      ).items.filter((item) => item.objectId === form.id);
      expect(logs.map((item) => item.action).sort()).toEqual([
        'evaluation.form.create',
        'evaluation.form.delete',
        'evaluation.form.update',
      ]);
      const details = await Promise.all(logs.map((item) => audit.dataChange(op.as, item.id)));
      const text = JSON.stringify({ logs, details });
      expect(text).toContain(g1.id);
      expect(text).toContain(t1.id);
      expect(text).not.toContain(g1.name);
      expect(text).not.toContain(t1.name);
      const update = details.find((entry) => entry.action.endsWith('.update'))!;
      expect(update.changes.map((change) => change.field)).toContain('passScore');
    });
  });
});

/** 响应里的评分项还原成可提交的形状（去掉展示用的名称）。 */
function sendable(item: FormView['items'][number]) {
  return {
    kind: item.kind,
    ...(item.generalItemId ? { generalItemId: item.generalItemId } : {}),
    ...(item.weight !== null ? { weight: item.weight } : {}),
    ...(item.hiddenTargets?.length ? { hiddenTargetIds: item.hiddenTargets.map((target) => target.id) } : {}),
  };
}
