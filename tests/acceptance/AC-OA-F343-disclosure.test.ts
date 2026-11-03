/**
 * F-343（BE-10b2 / BE-10c 组织明细的披露与授权，DEC-406；后补-权限，并入 F-087）：
 * ① 隐藏行（涉及的组织在组织范围外）与不存在的行，改 / 删 / 刷新基线返回同一错误；
 * ② 编码重复的文案不带出看不到的 `orgItems.code`；
 * ③ 明细写入另判组织对象字段写权（§6.3 “组织明细”行：组织对象 create / update 字段编辑权）；
 * ④ 经 `itemId` 引用本单新增行作上级时，按引用链上的真实组织复核范围；
 * ⑤ 缩小调整范围的 400 不带出看不到的明细 / 组织 ID；
 * BE-10c 补充：审批人编辑隐藏行与不存在的行同一口径。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { BASE, bodyOf, expectError, only } from './AC-OA-head-support.js';
import { itemsWorld, newOrg, reasons, rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();

/** 范围甲下有下级；一条可见行（甲）与一条隐藏行（下级，组织对象范围只含甲）。 */
async function hiddenWorld(label: string) {
  const w = await itemsWorld(testDb().db, label);
  const child = await w.org(`下级${randomUUID()}`, w.a);
  const view = await w.created(w.head({ adjustmentRange: [w.a] }));
  const visible = (await w.item(view.id, rename(w.a))).items.at(-1)!.id;
  const hidden = (await w.item(view.id, rename(child))).items.at(-1)!.id;
  w.access.org = only(w.a);
  return { w, view, child, visible, hidden };
}

describe('F-343 ① 隐藏行与不存在的行同一错误', () => {
  it('改 / 删 / 刷新单行：隐藏行与随机行 ID 的错误逐字节相同，单据不变；可见行照常，旧 revision 仍 409', async () => {
    const { w, view, visible, hidden } = await hiddenWorld('f343-hidden-row');
    const revision = (await w.stored(view.id))!.revision;
    const calls: Record<string, (rowId: string) => Promise<Response>> = {
      patch: (rowId) => w.patchItem(view.id, rowId, { name: '改' }),
      delete: (rowId) => w.deleteItem(view.id, rowId),
      rebase: (rowId) => w.rebaseItem(view.id, rowId),
    };
    for (const [name, call] of Object.entries(calls)) {
      const missing = await call(randomUUID());
      const outside = await call(hidden);
      await expectError(missing, 404, 'NOT_FOUND');
      await expectError(outside, 404, 'NOT_FOUND');
      expect((await bodyOf(outside)).error, name).toEqual((await bodyOf(missing)).error);
    }
    expect((await w.stored(view.id))!.revision).toBe(revision);

    expect((await w.patchItem(view.id, visible, { name: '可见行改名' })).status).toBe(200);
    await expectError(await w.patchItem(view.id, visible, { name: '过期' }, revision), 409, 'CONFLICT');
  });

  it('整单刷新基线：含隐藏行的单据与不存在的单据同一错误；重放同一命令不能绕过', async () => {
    const { w, view } = await hiddenWorld('f343-hidden-rebase-all');
    const send = (id: string, idempotencyKey?: string) =>
      w.call('POST', `${BASE}/${id}/rebase`, { ifMatch: 3, body: {}, idempotencyKey });
    const missing = await send(randomUUID());
    const outside = await send(view.id, randomUUID());
    await expectError(missing, 404, 'NOT_FOUND');
    await expectError(outside, 404, 'NOT_FOUND');
    expect((await bodyOf(outside)).error).toEqual((await bodyOf(missing)).error);
  });
});

describe('F-343 ② 编码重复的文案不带出看不到的编码', () => {
  async function takenCode(w: Awaited<ReturnType<typeof itemsWorld>>) {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ code: string }>(
        await tx.execute(sql`SELECT code FROM org_versions WHERE org_id = ${w.b} ORDER BY version_no DESC LIMIT 1`),
      );
      return row!.code;
    });
  }

  it('保存：看不到 orgItems.code → 409 ORG_CODE_DUPLICATE 的文案不含该编码；看得到时原样给出（正向对照）', async () => {
    const w = await itemsWorld(testDb().db, 'f343-code-save');
    const view = await w.created();
    const taken = await takenCode(w);
    w.access.hiddenFields = new Set(['orgItems.code']);
    const hidden = await w.addItem(view.id, newOrg(w.a, { code: taken }));
    await expectError(hidden, 409, 'CONFLICT', 'ORG_CODE_DUPLICATE');
    expect(JSON.stringify(await bodyOf(hidden))).not.toContain(taken);

    w.access.hiddenFields = new Set();
    const shown = await w.addItem(view.id, newOrg(w.a, { code: taken }));
    await expectError(shown, 409, 'CONFLICT', 'ORG_CODE_DUPLICATE');
    expect(JSON.stringify(await bodyOf(shown))).toContain(taken);
  });

  it('整单校验：保存后才被占用的编码，看不到 orgItems.code 时问题文案不含编码，原因码不变', async () => {
    const w = await itemsWorld(testDb().db, 'f343-code-check');
    const view = await w.created();
    const code = `LATE${randomUUID().replaceAll('-', '')}`;
    await w.item(view.id, newOrg(w.a, { code }));
    const occupied = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name: `占码${randomUUID()}`, code, establishedOn: '2020-01-01', parents: { admin: { parentId: w.b } } },
    });
    expect(occupied.status, await occupied.clone().text()).toBe(201);

    w.access.hiddenFields = new Set(['orgItems.code']);
    const hidden = await w.checked(view.id);
    expect(reasons(hidden)).toContain('ORG_CODE_DUPLICATE');
    expect(JSON.stringify(hidden)).not.toContain(code);

    w.access.hiddenFields = new Set();
    expect(JSON.stringify(await w.checked(view.id))).toContain(code);
  });
});

describe('F-343 ③ 明细写入另判组织对象字段写权', () => {
  it('新增：组织对象的 name / parents 不可写 → 403，不落行；只带可写字段照常 201（正向对照）', async () => {
    const w = await itemsWorld(testDb().db, 'f343-org-write-add');
    const view = await w.created();
    w.access.deniedFields = new Set(['name']);
    await expectError(await w.addItem(view.id, newOrg(w.a)), 403, 'FORBIDDEN');
    w.access.deniedFields = new Set(['parents']);
    await expectError(await w.addItem(view.id, newOrg(w.a)), 403, 'FORBIDDEN');
    expect(await w.rows(view.id)).toHaveLength(0);

    w.access.deniedFields = new Set(['code']);
    expect((await w.addItem(view.id, newOrg(w.a))).status).toBe(201);
  });

  it('修改：改名行的 name 不可写 → 403，只改简称照常 200；重放同键命令时撤了字段权 → 403', async () => {
    const w = await itemsWorld(testDb().db, 'f343-org-write-patch');
    const view = await w.created();
    const rowId = (await w.item(view.id, rename(w.a))).items.at(-1)!.id;
    const before = (await w.rows(view.id)).find((row) => row.id === rowId)!.name;

    w.access.deniedFields = new Set(['name']);
    await expectError(await w.patchItem(view.id, rowId, { name: '无权改名' }), 403, 'FORBIDDEN');
    expect((await w.rows(view.id)).find((row) => row.id === rowId)!.name).toBe(before);
    expect((await w.patchItem(view.id, rowId, { shortName: '简称' })).status).toBe(200);

    w.access.deniedFields = new Set();
    const idempotencyKey = randomUUID();
    const send = async () =>
      w.call('POST', `${BASE}/${view.id}/org-items`, {
        ifMatch: (await w.stored(view.id))!.revision,
        body: newOrg(w.a),
        idempotencyKey,
      });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(201);
    w.access.deniedFields = new Set(['name']);
    await expectError(await send(), 403, 'FORBIDDEN');
  });
});

describe('F-343 ④ itemId 引用的新增行按真实上级复核组织范围', () => {
  it('引用的新增行真实上级在组织范围外 → 与引用不存在的行同一 404；范围内照常 201（正向对照）', async () => {
    const w = await itemsWorld(testDb().db, 'f343-virtual-parent');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const first = (await w.item(view.id, newOrg(w.a))).items.at(-1)!.id;
    const second = (await w.item(view.id, newOrg(w.a, { parent: { itemId: first } }))).items.at(-1)!.id;
    const under = (id: string) => newOrg(w.a, { parent: { itemId: id } });

    w.access.org = only(w.b);
    const missing = await w.addItem(view.id, under(randomUUID()));
    await expectError(missing, 404, 'NOT_FOUND');
    for (const id of [first, second]) {
      const outside = await w.addItem(view.id, under(id));
      await expectError(outside, 404, 'NOT_FOUND');
      expect((await bodyOf(outside)).error).toEqual((await bodyOf(missing)).error);
    }
    expect(await w.rows(view.id)).toHaveLength(2);

    w.access.org = only(w.a);
    expect((await w.addItem(view.id, under(second))).status).toBe(201);
  });
});

describe('F-343 ⑤ 缩小调整范围的 400 不带出看不到的明细 / 组织 ID', () => {
  async function narrowWorld(label: string) {
    const w = await itemsWorld(testDb().db, label);
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const visible = (await w.item(view.id, rename(w.a))).items.at(-1)!.id;
    const hidden = (await w.item(view.id, rename(child))).items.at(-1)!.id;
    return { w, view, child, visible, hidden };
  }

  it('组织范围只含甲与乙：下级上的行是隐藏行 → 400 只列可见行，隐藏行并入一条汇总', async () => {
    const { w, view, child, visible, hidden } = await narrowWorld('f343-narrow-scope');
    w.access.org = only(w.a, w.b);
    const res = await w.patch(view.id, { adjustmentRange: [w.b] }, 3);
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    const text = JSON.stringify(await bodyOf(res));
    expect(text).not.toContain(child);
    expect(text).not.toContain(hidden);
    const { details } = (await bodyOf(res)).error as { details: { items: Record<string, unknown>[] } };
    expect(details.items.find((item) => item.itemId === visible)).toMatchObject({ orgId: w.a });
    expect(details.items.find((item) => item.itemId === undefined)).toMatchObject({
      section: 'org',
      reason: 'ORG_ADJUSTMENT_HIDDEN_ROW_INVALID',
      hiddenRowCount: 1,
    });
    expect((await w.stored(view.id))!.revision).toBe(3);
  });

  it('字段查看权：看不到 orgItems.targetOrgId → 问题不带 orgId；看得到时原样给出（正向对照）', async () => {
    const { w, view, visible } = await narrowWorld('f343-narrow-field');
    w.access.hiddenFields = new Set(['orgItems.targetOrgId']);
    const hidden = await w.patch(view.id, { adjustmentRange: [w.b] }, 3);
    await expectError(hidden, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    const hiddenItems = ((await bodyOf(hidden)).error as { details: { items: object[] } }).details.items;
    for (const item of hiddenItems) expect(item).not.toHaveProperty('orgId');

    w.access.hiddenFields = new Set();
    const shown = await w.patch(view.id, { adjustmentRange: [w.b] }, 3);
    const shownItems = ((await bodyOf(shown)).error as { details: { items: Record<string, unknown>[] } }).details.items;
    expect(shownItems.find((item) => item.itemId === visible)).toMatchObject({ orgId: w.a });
  });
});

describe('F-343 BE-10c 补充：审批人编辑隐藏行与不存在的行同一口径', () => {
  it('隐藏行（涉及的组织在审批人组织范围外）与随机行 ID 同为 400，单据不变；可见行照常 200', async () => {
    const w = await flowWorld(testDb().db, 'f343-approver-edit');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const { id, itemId } = await w.draft();
    const hidden = (await w.item(id, rename(child))).items.at(-1)!.id;
    await w.submitted(id);
    const before = await w.state(id);

    w.access.org = only(w.a);
    const edit = (rowId: string, value = '审批人改') =>
      w.act(id, w.hrbp, 'edit', { fields: { 'orgItems.name': [{ itemId: rowId, value }] } });
    const missing = await edit(randomUUID());
    const outside = await edit(hidden);
    expect(missing.status, await missing.clone().text()).toBe(400);
    expect(outside.status, await outside.clone().text()).toBe(400);
    expect((await bodyOf(outside)).error).toEqual((await bodyOf(missing)).error);
    expect(await w.state(id)).toEqual(before);

    const ok = await edit(itemId);
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
