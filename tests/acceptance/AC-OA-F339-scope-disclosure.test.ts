/**
 * F-339（BE-10b1 组织调整三项信息披露，DEC-406；后补-权限，并入 F-087）：
 * ① 命令重放回执按当前组织范围复核（PATCH 的调整范围也一样）；
 * ② 整单校验信封 errors[] 按字段查看权与组织范围裁剪（隐藏行的问题不带出组织 ID / 明细 ID / 业务文案）；
 * ③ 由库里现值推出的范围外组织与不存在的申请单，错误码、文案、details 完全相同。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ALL, BASE, bodyOf, expectError, only } from './AC-OA-head-support.js';
import { type CheckResult, itemsWorld, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();

describe('F-339 ① 命令重放回执按当前组织范围复核', () => {
  it('创建：范围不变时重放得首次结果；调整范围移出组织范围后重放 404，且不披露回执内容', async () => {
    const w = await itemsWorld(testDb().db, 'f339-replay-create');
    const idempotencyKey = randomUUID();
    const body = w.head({ adjustmentRange: [w.a] });
    const send = () => w.call('POST', BASE, { ifMatch: 0, body, idempotencyKey });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(201);
    const same = await send();
    expect(same.status).toBe(201);
    expect(await same.json()).toEqual(await first.json());

    w.access.org = only(w.b);
    const out = await send();
    await expectError(out, 404, 'NOT_FOUND');
    expect(JSON.stringify(await bodyOf(out))).not.toContain(body.subject as string);
    expect(await w.count()).toBe(2);
  });

  it('PATCH 改调整范围：重放按回执里的新范围复核（旧范围已不在回执，不影响放行）；新范围出范围 → 404', async () => {
    const w = await itemsWorld(testDb().db, 'f339-replay-patch');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const idempotencyKey = randomUUID();
    const send = () =>
      w.call('PATCH', `${BASE}/${view.id}`, { ifMatch: 1, body: { adjustmentRange: [w.b] }, idempotencyKey });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);

    w.access.org = only(w.b);
    const again = await send();
    expect(again.status, '旧范围（甲）已不在单据里，只复核新范围（乙）').toBe(200);
    expect(await again.json()).toEqual(await first.json());

    w.access.org = only(w.a);
    await expectError(await send(), 404, 'NOT_FOUND');
    w.access.org = ALL;
    expect((await send()).status).toBe(200);
  });
});

describe('F-339 ② 整单校验信封 errors[] 的裁剪', () => {
  /** 范围甲下有下级甲一；停用甲连带甲一，两者在生效日都有编制 → 发起行与连带行各报一条编制关口问题。 */
  async function stopWorld(label: string, parentCapacity = true) {
    const w = await itemsWorld(testDb().db, label);
    const child = await w.org(`下级${randomUUID()}`, w.a);
    if (parentCapacity) await w.capacity(w.a);
    await w.capacity(child);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const written = await w.item(view.id, stop(w.a));
    const rows = await w.rows(view.id);
    const cascaded = rows.find((row) => row.target_org_id === child)!;
    return { w, view, child, startId: written.items[0]!.id, cascadedId: cascaded.id };
  }
  const errorsOf = async (w: Awaited<ReturnType<typeof stopWorld>>['w'], id: string) =>
    (await (await w.check(id)).json()) as CheckResult;

  it('组织对象范围不含下级 → 连带行是隐藏行：问题不带出其组织 ID / 明细 ID，只并入一条隐藏行汇总', async () => {
    const { w, view, child, startId, cascadedId } = await stopWorld('f339-check-scope');
    const all = await errorsOf(w, view.id);
    expect(all.errors.map((e) => [e.itemId, e.orgId])).toEqual(
      expect.arrayContaining([
        [startId, w.a],
        [cascadedId, child],
      ]),
    );

    w.access.org = only(w.a);
    const trimmed = await errorsOf(w, view.id);
    expect(trimmed.valid).toBe(false);
    const text = JSON.stringify(trimmed);
    expect(text).not.toContain(child);
    expect(text).not.toContain(cascadedId);
    expect(trimmed.errors.find((e) => e.itemId === startId)).toMatchObject({ orgId: w.a });
    expect(trimmed.errors.filter((e) => e.itemId === startId || e.itemId === undefined)).toHaveLength(2);
    expect(trimmed.errors.find((e) => e.itemId === undefined)).toMatchObject({
      section: 'org',
      reason: 'ORG_ADJUSTMENT_HIDDEN_ROW_INVALID',
      hiddenRowCount: 1,
    });
  });

  it('只有隐藏行有问题 → valid 仍为 false，errors 只有汇总一条', async () => {
    const { w, view, child } = await stopWorld('f339-check-only-hidden', false);
    w.access.org = only(w.a);
    const trimmed = await errorsOf(w, view.id);
    expect(trimmed.valid).toBe(false);
    expect(trimmed.errors).toHaveLength(1);
    expect(trimmed.errors[0]).toMatchObject({ reason: 'ORG_ADJUSTMENT_HIDDEN_ROW_INVALID', hiddenRowCount: 1 });
    expect(JSON.stringify(trimmed)).not.toContain(child);
  });

  it('字段查看权：看不到 orgItems.targetOrgId → 问题不带 orgId；看得到时原样给出（正向对照）', async () => {
    const { w, view, startId } = await stopWorld('f339-check-field');
    w.access.hiddenFields = new Set(['orgItems.targetOrgId']);
    const hidden = await errorsOf(w, view.id);
    for (const error of hidden.errors) expect(error).not.toHaveProperty('orgId');
    expect(hidden.errors.find((e) => e.itemId === startId)).toBeDefined();
    w.access.hiddenFields = new Set();
    const shown = await errorsOf(w, view.id);
    expect(shown.errors.find((e) => e.itemId === startId)).toMatchObject({ orgId: w.a });
  });
});

describe('F-339 ③ 范围外组织与不存在的申请单同一口径', () => {
  it('作废 / 修改 / 整单校验 / 提交 / 撤回：现值的调整范围出组织范围 → 与不存在的申请单逐字节相同的 404', async () => {
    const w = await itemsWorld(testDb().db, 'f339-same-error');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const calls: Record<string, (id: string) => Promise<Response>> = {
      patch: (id) => w.patch(id, { content: '改' }, 1),
      void: (id) => w.voidIt(id, 1),
      check: (id) => w.check(id),
      submit: (id) => w.call('POST', `${BASE}/${id}/submit`, { ifMatch: 1, body: {} }),
      withdraw: (id) => w.call('POST', `${BASE}/${id}/withdraw`, { ifMatch: 1, body: {} }),
    };
    w.access.org = only(w.b);
    for (const [name, call] of Object.entries(calls)) {
      const outside = await call(view.id);
      const missing = await call(randomUUID());
      await expectError(missing, 404, 'NOT_FOUND');
      await expectError(outside, 404, 'NOT_FOUND');
      expect((await bodyOf(outside)).error, name).toEqual((await bodyOf(missing)).error);
    }
    expect((await w.stored(view.id))!.revision).toBe(1);
  });

  it('正向对照：范围内的操作照常成功；请求里新给的范围外组织与不存在的组织仍同为“组织不存在”', async () => {
    const w = await itemsWorld(testDb().db, 'f339-same-error-control');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    w.access.org = only(w.a);
    expect((await w.check(view.id)).status).toBe(200);
    expect((await w.patch(view.id, { content: '改' }, 1)).status).toBe(200);
    const outside = await w.patch(view.id, { adjustmentRange: [w.b] }, 2);
    const missing = await w.patch(view.id, { adjustmentRange: [randomUUID()] }, 2);
    await expectError(outside, 404, 'NOT_FOUND');
    expect((await bodyOf(outside)).error).toEqual((await bodyOf(missing)).error);
    expect((await w.stored(view.id))!.revision).toBe(2);
  });
});
