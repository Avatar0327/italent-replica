import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { expectError } from './AC-OA-head-support.js';
import { type ItemsWorld, itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

/** 可信夹具：追加一条同开始日的组织版本，行政上级改为 parentId（模拟组织被直接移动）。 */
async function moveOrg(w: ItemsWorld, orgId: string, parentId: string) {
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
      .values({ ...old!, id: versionId, versionNo: old!.versionNo + 1, previousVersionId: old!.id });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    await tx
      .insert(orgHierarchyLinks)
      .values(
        links.map((link) => ({ ...link, versionId, ...(link.dimension === 'admin' && { parentOrgId: parentId }) })),
      );
  });
}

/** 可信夹具：绕过保存校验直接落一条新增行（模拟按旧规则保存过的明细），返回行 ID。 */
async function rawCreateRow(w: ItemsWorld, adjustmentId: string, columns: { hrbpId?: string; code?: string }) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ id: string }>(
      await tx.execute(sql`INSERT INTO org_adjustment_org_items (tenant_id, adjustment_id, seq, adjust_type, name,
          parent_org_id, hrbp_id, code)
        VALUES (${w.tenant.id}, ${adjustmentId},
          (SELECT coalesce(max(seq), 0) + 1 FROM org_adjustment_org_items WHERE adjustment_id = ${adjustmentId}),
          1, ${`旧行${uniqueSuffix()}`}, ${w.a}, ${columns.hrbpId ?? null}, ${columns.code ?? null})
        RETURNING id`),
    );
    return row!.id;
  });
}

const move = (targetOrgId: string, parentOrgId: string) => ({
  entry: 'detail.change',
  adjustType: 2,
  targetOrgId,
  parent: { orgId: parentOrgId },
  addEmployment: false,
});

describe('AC-OA-01 / AC-OA-43 R2 P2-1 同级新增 editor.peer（§6.2：siblingOf，服务端取同级来源的上级）', () => {
  it('siblingOf 引用既有组织 / 本单新增行 → 201，上级取来源的上级；入口与 siblingOf 不配套 → 400', async () => {
    const w = await itemsWorld(testDb().db, 'oar2peer');
    const source = await w.org(`同级来源${uniqueSuffix()}`, w.a);
    const view = await w.created();
    const peer = { entry: 'editor.peer', adjustType: 1 };
    const byOrg = await w.item(view.id, { ...peer, siblingOf: { orgId: source }, name: `同级甲${uniqueSuffix()}` });
    expect(byOrg.items[0]).toMatchObject({ adjustType: 1, parentOrgId: w.a, parentItemId: null });

    const upper = (await w.item(view.id, newOrg(w.a))).items[0]!.id;
    const lower = (await w.item(view.id, { ...newOrg(w.a), parent: { itemId: upper } })).items[0]!.id;
    const byItem = await w.item(view.id, { ...peer, siblingOf: { itemId: lower }, name: `同级乙${uniqueSuffix()}` });
    expect(byItem.items[0]).toMatchObject({ parentOrgId: null, parentItemId: upper });

    const before = (await w.rows(view.id)).length;
    await expectError(await w.addItem(view.id, { ...peer, name: '缺来源' }), 400, 'VALIDATION_FAILED');
    await expectError(
      await w.addItem(view.id, { ...peer, siblingOf: { orgId: source }, parent: { orgId: w.a }, name: '另填上级' }),
      400,
      'VALIDATION_FAILED',
    );
    await expectError(
      await w.addItem(view.id, { ...newOrg(w.a), siblingOf: { orgId: source } }),
      400,
      'VALIDATION_FAILED',
    );
    expect(await w.rows(view.id)).toHaveLength(before);
  });
});

describe('AC-OA-01 / AC-OA-16 / AC-OA-42 R2 P2-2 整单校验在当前生效日重判上级可用、调整范围、停用日期（§5.2 / §5.6）', () => {
  it('新增行的上级之后被停用 → 校验报 ORG_INACTIVE', async () => {
    const w = await itemsWorld(testDb().db, 'oar2chk');
    const parent = await w.org(`上级${uniqueSuffix()}`, w.a);
    const view = await w.created();
    const itemId = (await w.item(view.id, newOrg(parent))).items[0]!.id;
    expect((await w.checked(view.id)).valid).toBe(true);
    await w.disable(parent);
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ itemId, reason: 'ORG_ADJUSTMENT_ORG_INACTIVE', orgId: parent }),
    );
  });

  it('目标组织被外部移出调整范围后刷新基线 → 校验仍报 OUT_OF_RANGE', async () => {
    const w = await itemsWorld(testDb().db, 'oar2chk');
    const target = await w.org(`目标${uniqueSuffix()}`, w.a);
    const view = await w.created();
    const itemId = (await w.item(view.id, rename(target))).items[0]!.id;
    await moveOrg(w, target, w.b);
    expect((await w.rebaseAll(view.id)).status).toBe(200);
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ itemId, reason: 'ORG_ADJUSTMENT_OUT_OF_RANGE', orgId: target }),
    );
  });

  it('停用单生效日改成组织设立日后刷新基线 → 校验报 DEACTIVATION_NOT_AFTER_ESTABLISHED', async () => {
    const w = await itemsWorld(testDb().db, 'oar2chk');
    const res = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name: `晚设立${uniqueSuffix()}`, establishedOn: '2026-11-01', parents: { admin: { parentId: w.a } } },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const late = ((await res.json()) as { id: string }).id;
    const view = await w.created({ ...w.head(), effectiveDate: '2026-12-01' });
    const itemId = (await w.item(view.id, stop(late))).items[0]!.id;
    expect((await w.checked(view.id)).valid).toBe(true);
    const patched = await w.patch(view.id, { effectiveDate: '2026-11-01' }, 2);
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.rebaseAll(view.id)).status).toBe(200);
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ itemId, reason: 'DEACTIVATION_NOT_AFTER_ESTABLISHED' }),
    );
  });
});

describe('AC-OA-01 R2 P2-3 组织角色人员资格（§5.2：复用 assertOrgPeopleEligible）', () => {
  it('保存 / 修改：无任职人员或不存在的人员 → 400 PERSON_NOT_ELIGIBLE，不留明细；在职人员可保存', async () => {
    const w = await itemsWorld(testDb().db, 'oar2ppl');
    const jobless = await w.employee(`无任职${uniqueSuffix()}`);
    const staff = await w.person(`在职${uniqueSuffix()}`, w.a);
    const view = await w.created();
    for (const hrbpId of [jobless.id, randomUUID()])
      await expectError(
        await w.addItem(view.id, newOrg(w.a, { hrbpId })),
        400,
        'VALIDATION_FAILED',
        'PERSON_NOT_ELIGIBLE',
      );
    expect(await w.rows(view.id)).toEqual([]);
    const created = await w.item(view.id, newOrg(w.a, { hrbpId: staff.employeeId }));
    const revision = (await w.stored(view.id))!.revision;
    await expectError(
      await w.patchItem(view.id, created.items[0]!.id, { hrbpId: jobless.id }),
      400,
      'VALIDATION_FAILED',
      'PERSON_NOT_ELIGIBLE',
    );
    expect((await w.stored(view.id))!.revision).toBe(revision);
  });

  it('整单校验：行上的 HRBP 在生效日无任职 → 报 PERSON_NOT_ELIGIBLE', async () => {
    const w = await itemsWorld(testDb().db, 'oar2ppl');
    const jobless = await w.employee(`无任职${uniqueSuffix()}`);
    const view = await w.created();
    const itemId = await rawCreateRow(w, view.id, { hrbpId: jobless.id });
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ itemId, reason: 'PERSON_NOT_ELIGIBLE' }));
  });
});

describe('AC-OA-01 R2 P2-4 编码复用 assertCodeAvailable 的格式与占用口径', () => {
  it('保存 / 修改：非法格式、保留编码 ROOT → 400 ORG_CODE_INVALID；被其它组织占用 → 409 ORG_CODE_DUPLICATE', async () => {
    const w = await itemsWorld(testDb().db, 'oar2code');
    const view = await w.created();
    for (const code of ['非法 编码', 'ROOT'])
      await expectError(await w.addItem(view.id, newOrg(w.a, { code })), 400, 'VALIDATION_FAILED', 'ORG_CODE_INVALID');
    const taken = await withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ code: string }>(
        await tx.execute(sql`SELECT code FROM org_versions WHERE org_id = ${w.b} ORDER BY version_no DESC LIMIT 1`),
      );
      return row!.code;
    });
    await expectError(await w.addItem(view.id, newOrg(w.a, { code: taken })), 409, 'CONFLICT', 'ORG_CODE_DUPLICATE');
    expect(await w.rows(view.id)).toEqual([]);
    const created = await w.item(view.id, newOrg(w.a, { code: `OK${uniqueSuffix()}` }));
    await expectError(
      await w.patchItem(view.id, created.items[0]!.id, { code: '非法 编码' }),
      400,
      'VALIDATION_FAILED',
      'ORG_CODE_INVALID',
    );
  });

  it('整单校验：行上编码格式非法 → 报 ORG_CODE_INVALID', async () => {
    const w = await itemsWorld(testDb().db, 'oar2code');
    const view = await w.created();
    const itemId = await rawCreateRow(w, view.id, { code: '非法 编码' });
    const result = await w.checked(view.id);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ itemId, reason: 'ORG_CODE_INVALID' }));
  });
});

describe('AC-OA-01 R2 P2-5 叠树错误按“本次操作新造成”拦截（操作前后问题集合取差集）', () => {
  it('先把合法子树移到 A 下，再移动 A 使最深后代到第 11 层 → 第二次保存 400，明细 / revision / 审计不变', async () => {
    const w = await itemsWorld(testDb().db, 'oar2plan');
    // a 为第 1 层：p2…p7 一条链（p7 在第 7 层）；x、s 在第 2 层，s ─ s2 ─ s3。
    let deepest = w.a;
    for (let level = 2; level <= 7; level++) deepest = await w.org(`链${level}-${uniqueSuffix()}`, deepest);
    const x = await w.org(`甲${uniqueSuffix()}`, w.a);
    const s = await w.org(`子树${uniqueSuffix()}`, w.a);
    const s2 = await w.org(`子树二${uniqueSuffix()}`, s);
    await w.org(`子树三${uniqueSuffix()}`, s2);
    const view = await w.created();
    await w.item(view.id, move(s, x));
    const revision = (await w.stored(view.id))!.revision;
    // x 到第 8 层 → s3 到第 11 层；超层归到离 s3 最近的改上级行（第一条），但它是本次操作新造成的。
    await expectError(
      await w.addItem(view.id, move(x, deepest)),
      400,
      'VALIDATION_FAILED',
      'ORG_ADJUSTMENT_LEVEL_EXCEEDED',
    );
    expect(await w.rows(view.id)).toHaveLength(1);
    expect((await w.stored(view.id))!.revision).toBe(revision);
    expect(await w.itemAudits(view.id)).toEqual(['org-adjustment.item.create']);
  });

  it('既有叠树错误可保留：不改变它的操作照常保存', async () => {
    const w = await itemsWorld(testDb().db, 'oar2plan');
    const first = await w.org(`链2-${uniqueSuffix()}`, w.a);
    let deepest = first;
    for (let level = 3; level <= 10; level++) deepest = await w.org(`链${level}-${uniqueSuffix()}`, deepest);
    const x = await w.org(`甲${uniqueSuffix()}`, w.a);
    await w.org(`甲下${uniqueSuffix()}`, x);
    const view = await w.created();
    // 可信夹具：直接落一条把 x 挂到第 10 层下的改上级行（x 的下级到第 12 层，既有错误）。
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO org_adjustment_org_items (tenant_id, adjustment_id, seq, adjust_type, target_org_id,
          parent_org_id, add_employment) VALUES (${w.tenant.id}, ${view.id}, 1, 2, ${x}, ${deepest}, false)`),
    );
    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain('ORG_ADJUSTMENT_LEVEL_EXCEEDED');
    const res = await w.addItem(view.id, rename(first));
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe('§2.5 / DEC-019 R2 P2-6 整单刷新基线写申请单级审计', () => {
  it('空单 / 仅含新增行：整单刷新 revision + 1 并写 org-adjustment.rebase 审计', async () => {
    const w = await itemsWorld(testDb().db, 'oar2rb');
    const empty = await w.created();
    expect((await w.rebaseAll(empty.id)).status).toBe(200);
    expect((await w.stored(empty.id))!.revision).toBe(2);
    expect(await w.audits(empty.id)).toEqual(['org-adjustment.create', 'org-adjustment.rebase']);

    const creates = await w.created();
    await w.item(creates.id, newOrg(w.a));
    expect((await w.rebaseAll(creates.id)).status).toBe(200);
    expect((await w.stored(creates.id))!.revision).toBe(3);
    expect(await w.audits(creates.id)).toEqual(['org-adjustment.create', 'org-adjustment.rebase']);
    expect(await w.itemAudits(creates.id)).toEqual(['org-adjustment.item.create']);
  });
});
