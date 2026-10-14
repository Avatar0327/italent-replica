/** DEC-413 / #216：标准模式评价表对齐取证，AC-EV-F091。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerFormLock } from '../../apps/api/src/modules/evaluation/form-lock.js';
import { registerInUse } from '../../apps/api/src/modules/evaluation/usage.js';
import { formOperator, FORMS, formWorld, type FormWorld, type FormView } from './AC-EV-form-support.js';
import { errorOf, ok } from './AC-EV-support.js';
import { uniqueSuffix } from './support/unique.js';

type AlignedForm = Omit<FormView, 'scoreMode' | 'fullScore' | 'passScore'> & {
  scoreMode: 'by_indicator' | 'by_total' | 'by_vote';
  fullScore: number | null;
  passScore: number | null;
  votePassRatio: number | null;
  indicatorReference: boolean;
  weightWarning: { total: number; message: string } | null;
};
const testDb = useTestDb();

describe('AC-EV-F091-align 评价表原站口径（DEC-413）', () => {
  let w: FormWorld;
  let op: Awaited<ReturnType<typeof formOperator>>;
  let generalId: string;
  beforeAll(async () => {
    w = await formWorld(testDb().db);
    op = await formOperator(w, { evOrgs: [w.orgA] });
    generalId = (await w.generalItem('F091通用评分项')).id;
    // B5 未合入：按现有 usage 契约登记一个隔离测试库引用方，验证真实服务调用而不是假锁。
    await testDb().db.execute(sql`CREATE TABLE ev_f091_refs (tenant_id uuid NOT NULL, form_id uuid NOT NULL)`);
    await testDb().db.execute(sql`GRANT SELECT ON ev_f091_refs TO app_user, app_platform`);
    registerInUse(
      'evaluationForm',
      {
        sql: (ctx, id) => sql`SELECT 1 FROM ev_f091_refs
        WHERE tenant_id = ${ctx.tenantId}::uuid AND form_id = ${id}::uuid`,
        message: '已在活动中使用此评价表，无法停用',
        reason: 'EVALUATION_FORM_IN_USE',
      },
      'disable',
    );
  });
  afterEach(() => registerFormLock(null));

  const body = (extra: Record<string, unknown> = {}) => ({
    name: `F091评价表${uniqueSuffix()}`,
    ownerOrgId: w.orgA,
    scoreMode: 'by_indicator',
    fullScore: 100,
    passScore: 60,
    totalRule: 'weighted',
    items: [{ kind: 'general', generalItemId: generalId, weight: 100 }],
    ...extra,
  });
  const create = (data: Record<string, unknown>) => op.request('POST', FORMS, { ifMatch: 0, body: data });
  const patch = (form: { id: string; revision: number }, data: Record<string, unknown>, key = randomUUID()) =>
    op.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: form.revision, idempotencyKey: key, body: data });
  const read = async (id: string) => ok<AlignedForm>(await op.request('GET', `${FORMS}/${id}`));

  it('AC-EV-F091-01 被活动引用时拒绝停用，固定原文；失败无业务、revision 和审计变化', async () => {
    const form = await ok<FormView>(await create(body()), 201);
    await testDb().db.execute(sql`INSERT INTO ev_f091_refs VALUES (${w.tenant.id}, ${form.id})`);
    const before = await read(form.id);
    const countWrites = () =>
      withTenant(testDb().db, w.tenant.id, async (tx) => {
        const result = await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
        WHERE object_id = ${form.id} AND action = 'evaluation.form.update'`);
        return (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows)[0].n;
      });
    const auditBefore = await countWrites();
    const key = randomUUID();
    const response = await patch(form, { enabled: false }, key);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.clone().json()).toMatchObject({
      error: {
        message: '已在活动中使用此评价表，无法停用',
        details: { reason: 'EVALUATION_FORM_IN_USE' },
      },
    });
    expect(await read(form.id)).toEqual(before);
    expect(await countWrites()).toBe(auditBefore);
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
      const rows = Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows;
      expect(rows[0].n).toBe(0);
    });
    await testDb().db.execute(sql`DELETE FROM ev_f091_refs WHERE form_id = ${form.id}`);
    const disabled = await ok<AlignedForm>(await patch(form, { enabled: false }));
    expect(disabled).toMatchObject({ enabled: false, revision: form.revision + 1 });
    expect(await ok<AlignedForm>(await patch(disabled, { enabled: true }))).toMatchObject({ enabled: true });
  });

  it('AC-EV-F091-02 平均 / 加权平均 / 加总都能保存；评总分保留评分项但不带权重', async () => {
    for (const totalRule of ['average', 'weighted', 'sum']) {
      const form = await ok<AlignedForm>(await create(body({ totalRule })), 201);
      expect(form.totalRule).toBe(totalRule);
    }
    const total = await ok<AlignedForm>(
      await create(
        body({
          scoreMode: 'by_total',
          totalRule: undefined,
          items: [{ kind: 'general', generalItemId: generalId }],
        }),
      ),
      201,
    );
    expect(total.totalRule).toBeNull();
    expect(total.items[0]).not.toHaveProperty('weight');
    expect((await read(total.id)).items).toEqual(total.items);
    const wrong = await patch(total, { items: [{ kind: 'general', generalItemId: generalId, weight: 10 }] });
    expect(wrong.status).toBe(400);
    expect(await read(total.id)).toEqual(total);
  });

  it('AC-EV-F091-03 投票只需比例，参考评分可开启；列表 / 详情 / 重放保留设置', async () => {
    const data = body({
      scoreMode: 'by_vote',
      votePassRatio: 60,
      indicatorReference: false,
      fullScore: undefined,
      passScore: undefined,
      totalRule: undefined,
      items: [{ kind: 'general', generalItemId: generalId }],
    });
    const key = randomUUID();
    const form = await ok<AlignedForm>(
      await op.request('POST', FORMS, {
        ifMatch: 0,
        idempotencyKey: key,
        body: data,
      }),
      201,
    );
    expect(form).toMatchObject({
      scoreMode: 'by_vote',
      votePassRatio: 60,
      indicatorReference: false,
      fullScore: null,
      passScore: null,
      totalRule: null,
    });
    expect(await read(form.id)).toEqual(form);
    const replay = await ok<AlignedForm>(
      await op.request('POST', FORMS, {
        ifMatch: 0,
        idempotencyKey: key,
        body: data,
      }),
      201,
    );
    expect(replay).toEqual(form);
    const referenced = await ok<AlignedForm>(
      await patch(form, {
        indicatorReference: true,
        fullScore: 100,
        passScore: 150,
        totalRule: 'average',
        items: [{ kind: 'general', generalItemId: generalId, weight: 100 }],
      }),
    );
    expect(referenced).toMatchObject({
      votePassRatio: 60,
      indicatorReference: true,
      fullScore: 100,
      passScore: 150,
      totalRule: 'average',
    });
    const page = await ok<{ items: AlignedForm[] }>(await op.request('GET', `${FORMS}?pageSize=100`));
    expect(page.items.find((item) => item.id === form.id)).toEqual(referenced);
  });

  it('AC-EV-F091-04 投票比例必填且为百分数；非投票不能带投票设置，失败无改动', async () => {
    const form = await ok<FormView>(await create(body()), 201);
    for (const data of [
      { scoreMode: 'by_vote', totalRule: null },
      { scoreMode: 'by_vote', totalRule: null, votePassRatio: -1 },
      { scoreMode: 'by_vote', totalRule: null, votePassRatio: 101 },
      { votePassRatio: 60 },
      { indicatorReference: true },
    ]) {
      expect((await patch(form, data)).status, JSON.stringify(data)).toBe(400);
      expect((await read(form.id)).revision).toBe(form.revision);
    }
  });

  it('AC-EV-F091-05 满分与通过分截到两位，不四舍五入；通过分可大于满分', async () => {
    const form = await ok<AlignedForm>(await create(body({ fullScore: 100.567, passScore: 150.239 })), 201);
    expect(form).toMatchObject({ fullScore: 100.56, passScore: 150.23 });
    const updated = await ok<AlignedForm>(await patch(form, { fullScore: 1.15, passScore: 1.999 }));
    expect(updated).toMatchObject({ fullScore: 1.15, passScore: 1.99 });
    expect(await read(form.id)).toEqual(updated);
  });

  it('AC-EV-F091-06 两种分数必须大于零；截后为零也拒绝；15 位允许、16 位拒绝', async () => {
    const form = await ok<AlignedForm>(await create(body({ fullScore: 999_999_999_999_999 })), 201);
    expect(form.fullScore).toBe(999_999_999_999_999);
    for (const field of ['fullScore', 'passScore']) {
      for (const value of [0, -1, 0.009, 1_000_000_000_000_000]) {
        const response = await patch(form, { [field]: value });
        expect(response.status, `${field}=${value}`).toBe(400);
        if (value === 0) expect(await response.text()).toContain('请设置大于0的数字');
        expect(await read(form.id)).toEqual(form);
      }
    }
  });

  it('AC-EV-F091-07 通用评分项集合不能重复，POST / PATCH 都拒绝；任职资格标准至多一条', async () => {
    const duplicate = [
      { kind: 'general', generalItemId: generalId, weight: 50 },
      { kind: 'general', generalItemId: generalId.toUpperCase(), weight: 50 },
    ];
    const response = await create(body({ items: duplicate }));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ reason: 'FORM_GENERAL_ITEM_DUPLICATE' });
    const form = await ok<FormView>(await create(body()), 201);
    expect((await patch(form, { items: duplicate })).status).toBe(400);
    expect((await patch(form, { items: [{ kind: 'standard' }, { kind: 'standard' }] })).status).toBe(400);
    expect((await read(form.id)).revision).toBe(form.revision);
  });

  it('AC-EV-F091-08 超过 50 条不同通用评分项可保存与整组编辑', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push((await w.generalItem(`F091评分项${i}`)).id);
    const items = ids.map((generalItemId) => ({ kind: 'general', generalItemId }));
    const form = await ok<AlignedForm>(await create(body({ items })), 201);
    expect(form.items.map((item) => item.generalItemId)).toEqual(ids);
    const updated = await ok<AlignedForm>(await patch(form, { items: [...items].reverse() }));
    expect(updated.items.map((item) => item.generalItemId)).toEqual([...ids].reverse());
  });

  it('AC-EV-F091-09 权重合计 90% 只警示；100% 无警示；评分项被隐藏时不披露警示', async () => {
    const form = await ok<AlignedForm>(
      await create(
        body({
          items: [
            { kind: 'standard', weight: 60 },
            { kind: 'general', generalItemId: generalId, weight: 30 },
          ],
        }),
      ),
      201,
    );
    expect(form.weightWarning).toMatchObject({ total: 90 });
    const hidden = await formOperator(w, { evOrgs: [w.orgA], hidden: ['items'] });
    const detail = await ok<Record<string, unknown>>(await hidden.request('GET', `${FORMS}/${form.id}`));
    expect(detail).not.toHaveProperty('items');
    expect(detail).not.toHaveProperty('weightWarning');
    const fixed = await ok<AlignedForm>(
      await patch(form, {
        items: [
          { kind: 'standard', weight: 70 },
          { kind: 'general', generalItemId: generalId, weight: 30 },
        ],
      }),
    );
    expect(fixed.weightWarning).toBeNull();
  });

  it('AC-EV-F091-10 模式切换隐含清空权重也复核评分项编辑权；有权时清空且不披露权重', async () => {
    const form = await ok<FormView>(await create(body()), 201);
    const readonly = await formOperator(w, { evOrgs: [w.orgA], readonly: ['items'] });
    const denied = await readonly.request('PATCH', `${FORMS}/${form.id}`, {
      ifMatch: form.revision,
      body: { scoreMode: 'by_total' },
    });
    expect(denied.status).toBe(403);
    expect((await read(form.id)).revision).toBe(form.revision);
    const updated = await ok<AlignedForm>(await patch(form, { scoreMode: 'by_total' }));
    expect(updated.items[0]).not.toHaveProperty('weight');
    expect(updated.totalRule).toBeNull();
    expect(updated.weightWarning).toBeNull();
  });

  it('AC-EV-F091-11 投票新增字段进入当前字段裁剪与 EV-R5 修改锁', async () => {
    const form = await ok<AlignedForm>(
      await create(
        body({
          scoreMode: 'by_vote',
          votePassRatio: 60,
          indicatorReference: true,
        }),
      ),
      201,
    );
    const hidden = await formOperator(w, { evOrgs: [w.orgA], hidden: ['votePassRatio', 'indicatorReference'] });
    const detail = await ok<Record<string, unknown>>(await hidden.request('GET', `${FORMS}/${form.id}`));
    expect(detail).not.toHaveProperty('votePassRatio');
    expect(detail).not.toHaveProperty('indicatorReference');
    registerFormLock(async () => true);
    for (const data of [{ votePassRatio: 70 }, { indicatorReference: false }]) {
      const response = await patch(form, data);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toMatchObject({ reason: 'FORM_LOCKED' });
      expect(await read(form.id)).toEqual(form);
    }
  });

  it('AC-EV-F091-12 数据库拒绝重复通用项与零通过分，允许通过分大于满分', async () => {
    const form = await ok<FormView>(await create(body()), 201);
    const tenant = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(testDb().db, w.tenant.id, work);
    await expect(
      tenant((tx) => tx.execute(sql`UPDATE ev_forms SET pass_score = 150 WHERE id = ${form.id}`)),
    ).resolves.toBeDefined();
    await expect(
      tenant((tx) => tx.execute(sql`UPDATE ev_forms SET pass_score = 0 WHERE id = ${form.id}`)),
    ).rejects.toThrow();
    await expect(
      tenant((tx) =>
        tx.execute(sql`INSERT INTO ev_form_items
      (tenant_id, form_id, kind, general_item_id, seq) VALUES
      (${w.tenant.id}, ${form.id}, 'general', ${generalId}, 9)`),
      ),
    ).rejects.toThrow();
  });
  it('AC-EV-F091-13 合计警示只用于响应，不作为业务字段持久化进审计', async () => {
    const form = await ok<FormView>(
      await create(body({ items: [{ kind: 'general', generalItemId: generalId, weight: 90 }] })),
      201,
    );
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT "after", changes FROM audit_events
        WHERE object_id = ${form.id} AND action = 'evaluation.form.create'`);
      const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        after: Record<string, unknown>;
        changes: { field: string }[];
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.after).not.toHaveProperty('weightWarning');
      expect(rows[0]!.changes.map((change) => change.field)).toContain('items');
      expect(rows[0]!.changes.map((change) => change.field)).not.toContain('weightWarning');
    });
  });
});
