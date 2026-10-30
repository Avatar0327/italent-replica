import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, bodyOf, expectError } from './AC-OA-head-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { itemsWorld, newOrg, reasons, rename, stop } from './AC-OA-items-support.js';

const testDb = useTestDb();
const NEED_CHOICE = '改名或改行政上级时必须选择是否新增任职';

describe('AC-OA-01 改名 / 改上级必填“是否新增任职”（OA-R3）与明细写入（§6.1）', () => {
  it('缺选择 → 400 原文、不留明细；只改简称却选择 → 400；选择后写入：revision + 1、ETag、审计、基线', async () => {
    const w = await itemsWorld(testDb().db, 'oa01');
    const view = await w.created();
    const { addEmployment: _omit, ...noChoice } = rename(w.a);
    const missing = await w.addItem(view.id, noChoice);
    await expectError(missing, 400, 'VALIDATION_FAILED');
    expect((await bodyOf(missing)).error?.message).toBe(NEED_CHOICE);
    await expectError(
      await w.addItem(view.id, {
        entry: 'detail.change',
        adjustType: 2,
        targetOrgId: w.a,
        parent: { orgId: w.subject },
      }),
      400,
      'VALIDATION_FAILED',
    );
    await expectError(
      await w.addItem(view.id, { ...rename(w.a), name: undefined, shortName: '简称' }),
      400,
      'VALIDATION_FAILED',
    );
    expect(await w.rows(view.id)).toEqual([]);
    expect((await w.stored(view.id))!.revision).toBe(1);

    const res = await w.addItem(view.id, rename(w.a, { addEmployment: true }), 1);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get('etag')).toBe('"2"');
    const body = (await res.json()) as { revision: number; items: { id: string; adjustType: number }[] };
    expect(body).toMatchObject({ adjustmentId: view.id, revision: 2, items: [{ adjustType: 2, targetOrgId: w.a }] });
    const [row] = await w.rows(view.id);
    expect(row).toMatchObject({ seq: 1, adjust_type: 2, target_org_id: w.a, is_staged: false });
    expect(row!.base_version_id).toEqual(expect.any(String));
    expect(row!.base_org_revision).toBeGreaterThan(0);
    expect(await w.itemAudits(view.id)).toEqual(['org-adjustment.item.create']);
    expect((await w.checked(view.id)).valid).toBe(true);
  });

  it('If-Match 过期 → 409 不写；同命令 ID 重放返回首次结果，不重复建行', async () => {
    const w = await itemsWorld(testDb().db, 'oa01');
    const view = await w.created();
    await expectError(await w.addItem(view.id, rename(w.a), 7), 409, 'REVISION_CONFLICT');
    const idempotencyKey = randomUUID();
    const send = () =>
      w.call('POST', `${BASE}/${view.id}/org-items`, {
        ifMatch: 1,
        body: rename(w.a, { name: '重放名' }),
        idempotencyKey,
      });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(201);
    const again = await send();
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    expect(await w.rows(view.id)).toHaveLength(1);
  });

  it('改行改删：PATCH 改名需带选择、DELETE 删行；各自 revision + 1 与审计', async () => {
    const w = await itemsWorld(testDb().db, 'oa01');
    const view = await w.created();
    const created = await w.item(view.id, newOrg(w.a, { name: '新建甲' }));
    const id = created.items[0]!.id;
    const patched = await w.patchItem(view.id, id, { name: '新建乙', code: `C${randomUUID()}` }, 2);
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.rows(view.id))[0]).toMatchObject({ name: '新建乙' });
    const renamed = await w.item(view.id, rename(w.a));
    await expectError(
      await w.patchItem(view.id, renamed.items[0]!.id, { addEmployment: null }),
      400,
      'VALIDATION_FAILED',
    );
    expect((await w.deleteItem(view.id, id, 4)).status).toBe(200);
    expect((await w.rows(view.id)).map((r) => r.target_org_id)).toEqual([w.a]);
    expect((await w.stored(view.id))!.revision).toBe(5);
    expect(await w.itemAudits(view.id)).toEqual([
      'org-adjustment.item.create',
      'org-adjustment.item.update',
      'org-adjustment.item.create',
      'org-adjustment.item.delete',
    ]);
  });

  it('同一既有组织只能一条明细 → 409；未知字段、入口与类型不符 → 400', async () => {
    const w = await itemsWorld(testDb().db, 'oa01');
    const view = await w.created();
    await w.item(view.id, rename(w.a));
    await expectError(await w.addItem(view.id, stop(w.a)), 409, 'CONFLICT', 'ORG_ADJUSTMENT_ITEM_DUPLICATE');
    await expectError(await w.addItem(view.id, { ...newOrg(w.a), unknown: 1 }), 400, 'VALIDATION_FAILED');
    await expectError(await w.addItem(view.id, { ...newOrg(w.a), entry: 'detail.stop' }), 400, 'VALIDATION_FAILED');
    await expectError(await w.addItem(view.id, { ...stop(w.a), entry: 'editor.change' }), 400, 'VALIDATION_FAILED');
    expect(await w.rows(view.id)).toHaveLength(1);
  });

  it('校验：成环、层级超 10、挂到本单停用整支下、停用本单新增组织 → 写入 400', async () => {
    const w = await itemsWorld(testDb().db, 'oa01');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created();
    await expectError(
      await w.addItem(view.id, rename(w.a, { name: undefined, parent: { orgId: child } })),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_CYCLE',
    );
    let parent: Record<string, string> = { orgId: child };
    for (let depth = 2; depth <= 10; depth++) {
      const res = await w.addItem(view.id, newOrg(w.a, { parent }));
      if (depth === 10) {
        await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_LEVEL_EXCEEDED');
        break;
      }
      expect(res.status, await res.clone().text()).toBe(201);
      parent = { itemId: ((await res.json()) as { items: { id: string }[] }).items[0]!.id };
    }
    const other = await w.created({ ...w.head(), adjustmentRange: [w.a] });
    await w.item(other.id, stop(child));
    await expectError(
      await w.addItem(other.id, newOrg(child)),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_PARENT_STOPPED',
    );
    const fresh = await w.item(other.id, newOrg(w.a));
    await expectError(await w.addItem(other.id, { ...stop(w.a), targetOrgId: fresh.items[0]!.id }), 404, 'NOT_FOUND');
  });

  it('填了编码须生效日唯一；目标组织已有晚于生效日的版本 → 校验报 ORG_FUTURE_VERSION_EXISTS', async () => {
    const w = await itemsWorld(testDb().db, 'oa01');
    const view = await w.created();
    const taken = await withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ code: string }>(
        await tx.execute(sql`SELECT code FROM org_versions WHERE org_id = ${w.b} ORDER BY version_no DESC LIMIT 1`),
      );
      return row?.code;
    });
    // 第 2 轮 P2-4：保存与整单校验同用 assertCodeAvailable 口径，已占用的编码保存即 409；保存后才被占用的由校验报出。
    await expectError(
      await w.addItem(view.id, newOrg(w.a, { code: taken ?? 'missing' })),
      409,
      'CONFLICT',
      'ORG_CODE_DUPLICATE',
    );
    const code = `LATE${randomUUID().replaceAll('-', '')}`;
    const created = await w.item(view.id, newOrg(w.a, { code }));
    expect(created.items).toHaveLength(1);
    const occupied = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name: `占码${randomUUID()}`, code, establishedOn: '2020-01-01', parents: { admin: { parentId: w.b } } },
    });
    expect(occupied.status, await occupied.clone().text()).toBe(201);
    expect(reasons(await w.checked(view.id))).toContain('ORG_CODE_DUPLICATE');
    const future = await w.call('PATCH', `/api/tenant/org/organizations/${w.a}`, {
      ifMatch: 1,
      body: { effectiveDate: '2026-12-01', name: `未来名${randomUUID()}`, addEmployment: false },
    });
    expect(future.status, await future.clone().text()).toBe(200);
    await w.item(view.id, rename(w.a));
    expect(reasons(await w.checked(view.id))).toContain('ORG_FUTURE_VERSION_EXISTS');
  });
});

describe('AC-OA-03 停用有人员的组织且未填转移组织：不允许提交；填转移组织 409（11d 前）', () => {
  it('校验报 ORG_SUBTREE_NOT_EMPTY；填转移组织写入 409；人员在下级也拦', async () => {
    const w = await itemsWorld(testDb().db, 'oa03');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    await w.person('在职员工', child);
    const view = await w.created();
    await expectError(
      await w.addItem(view.id, stop(w.a, { transferTo: { orgId: w.b } })),
      409,
      'CONFLICT',
      'ORG_ADJUSTMENT_TRANSFER_NOT_AVAILABLE',
    );
    expect(await w.rows(view.id)).toEqual([]);
    await w.item(view.id, stop(w.a));
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ section: 'org', reason: 'ORG_SUBTREE_NOT_EMPTY' }));
  });

  it('空组织停用校验通过；整支在生效日有编制 → 校验报 ORG_ADJUSTMENT_ESTABLISHMENT_END_NOT_AVAILABLE', async () => {
    const w = await itemsWorld(testDb().db, 'oa03');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created();
    await w.item(view.id, stop(w.a));
    expect((await w.checked(view.id)).valid).toBe(true);
    await w.capacity(child);
    expect(reasons(await w.checked(view.id))).toContain('ORG_ADJUSTMENT_ESTABLISHMENT_END_NOT_AVAILABLE');
  });
});

describe('AC-OA-04 停用有 2 个下级的组织：连带行与 100 条上限（OA-R5 / OA-R16）', () => {
  it('3 行（2 条连带行指向发起行）；删发起行连带行一并删；连带行不能单独改删', async () => {
    const w = await itemsWorld(testDb().db, 'oa04');
    const c1 = await w.org(`下级一${randomUUID()}`, w.a);
    const c2 = await w.org(`下级二${randomUUID()}`, w.a);
    const view = await w.created();
    const result = await w.item(view.id, stop(w.a));
    const root = result.items[0]!;
    expect(result.items).toHaveLength(3);
    const rows = await w.rows(view.id);
    expect(rows.map((r) => r.target_org_id).sort()).toEqual([w.a, c1, c2].sort());
    expect(rows.filter((r) => r.cascaded_from_item_id === root.id)).toHaveLength(2);
    const cascaded = rows.find((r) => r.target_org_id === c1)!;
    await expectError(await w.deleteItem(view.id, cascaded.id), 409, 'CONFLICT', 'ORG_ADJUSTMENT_ITEM_CASCADED');
    expect((await w.deleteItem(view.id, root.id)).status).toBe(200);
    expect(await w.rows(view.id)).toEqual([]);
  });

  it('连带行计入 100 条：98 条 + 停用（含 2 下级）→ 413，带 section / limit / count', async () => {
    const w = await itemsWorld(testDb().db, 'oa04');
    await w.org(`下级一${randomUUID()}`, w.a);
    await w.org(`下级二${randomUUID()}`, w.a);
    const view = await w.created();
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (let seq = 1; seq <= 98; seq++)
        await tx.execute(sql`INSERT INTO org_adjustment_org_items (tenant_id, adjustment_id, seq, adjust_type, name,
          parent_org_id) VALUES (${w.tenant.id}, ${view.id}, ${seq}, 1, ${`批量${seq}`}, ${w.a})`);
    });
    const res = await w.addItem(view.id, stop(w.a));
    await expectError(res, 413, 'PAYLOAD_TOO_LARGE', 'ORG_ADJUSTMENT_LIMIT_EXCEEDED');
    expect((await bodyOf(res)).error?.details).toMatchObject({ section: 'org', limit: 100, count: 101 });
    expect(await w.rows(view.id)).toHaveLength(98);
    expect((await w.addItem(view.id, newOrg(w.a))).status).toBe(201);
    expect((await w.addItem(view.id, newOrg(w.a))).status).toBe(201);
    await expectError(await w.addItem(view.id, newOrg(w.a)), 413, 'PAYLOAD_TOO_LARGE');
  });
});

describe('AC-OA-16 停用日早于或等于设立日（R2f3）', () => {
  it('本组织或连带下级设立日 ≥ 生效日 → 400 原站原文，不留明细', async () => {
    const w = await itemsWorld(testDb().db, 'oa16');
    const late = async (parentId: string, name: string) => {
      const res = await w.call('POST', '/api/tenant/org/organizations', {
        ifMatch: 0,
        body: { name, establishedOn: '2026-11-01', parents: { admin: { parentId } } },
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const lateRoot = await late(w.a, `晚设立${randomUUID()}`);
    const lateChildName = `晚设立下级${randomUUID()}`;
    await late(w.b, lateChildName);
    const view = await w.created({ ...w.head(), adjustmentRange: [w.a, w.b] });
    for (const [target, name] of [
      [lateRoot, null],
      [w.b, lateChildName],
    ] as const) {
      const res = await w.addItem(view.id, stop(target));
      await expectError(res, 400, 'VALIDATION_FAILED', 'DEACTIVATION_NOT_AFTER_ESTABLISHED');
      const message = (await bodyOf(res)).error!.message;
      expect(message).toMatch(/^组织【.+】的停用日期（2026-11-01）不能早于等于该组织的设立日期（2026-11-01）$/);
      if (name) expect(message).toContain(name);
    }
    expect(await w.rows(view.id)).toEqual([]);
  });
});
