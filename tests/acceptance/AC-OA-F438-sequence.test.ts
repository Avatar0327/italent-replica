/**
 * F-438 / DEC-745：改上级不填顺序号时沿用组织原顺序号（F273A §8.2：北森“编辑”直改已实测沿用）。
 * ① 组织直改（PATCH 只给新上级、不给 sequence）→ 新版本的行政顺序号仍是原值；显式给 null 才清空。
 * ② 组织调整明细（变更明细改上级、拖拽改上级）不填顺序号 → 明细存空（= 不变），预览在新上级下按原顺序号排。
 * 审批执行路径的组织变更执行器随 BE-11b 接入（设计 §2.2 display_order 行写明同口径），本文件不覆盖。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type ItemsWorld, itemsWorld } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';
import { orgSession } from './AC-ORG-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

interface OrgView {
  id: string;
  revision: number;
  parents: { admin?: { parentId: string; sequence: number | null } };
}

describe('F-438 / DEC-745 组织直改：只改上级不填顺序号 → 沿用原顺序号', () => {
  it('PATCH 只给新上级 → 顺序号仍为 7；显式给 null → 清空', async () => {
    const s = await orgSession(testDb().db, 'f438seq');
    const p1 = await s.create(`原上级${uniqueSuffix()}`);
    const p2 = await s.create(`新上级${uniqueSuffix()}`);
    const x = await s.create(`改上级部门${uniqueSuffix()}`, {
      parents: { admin: { parentId: p1.id, sequence: 7 } },
    });
    const read = async (asOf: string) => {
      const res = await s.request('GET', `/organizations/${x.id}?asOf=${asOf}`);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as OrgView;
    };
    const moved = await s.request('PATCH', `/organizations/${x.id}`, {
      ifMatch: x.revision,
      body: { effectiveDate: '2026-10-02', parents: { admin: { parentId: p2.id } }, addEmployment: false },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const after = await read('2026-10-02');
    expect(after.parents.admin).toEqual({ parentId: p2.id, sequence: 7 });

    // 对照：显式清空与“不填”是两回事
    const cleared = await s.request('PATCH', `/organizations/${x.id}`, {
      ifMatch: after.revision,
      body: {
        effectiveDate: '2026-10-03',
        parents: { admin: { parentId: p1.id, sequence: null } },
        addEmployment: false,
      },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect((await read('2026-10-03')).parents.admin).toEqual({ parentId: p1.id, sequence: null });
  });
});

/** 在 parent 下建一个带行政顺序号的组织（组织模块写入口，与界面同路径）。 */
async function orgWithSequence(w: ItemsWorld, name: string, parentId: string, sequence: number) {
  const created = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name, establishedOn: '2020-01-01', parents: { admin: { parentId, sequence } } },
    }),
    201,
  );
  return created.id;
}

describe('F-438 / DEC-745 组织调整明细改上级不填顺序号 → 明细存空，预览按原顺序号排', () => {
  for (const entry of ['detail.change', 'editor.drag'] as const) {
    it(`${entry}：x（原顺序号 30）挂到 b 下，排在 b 的 10 与 50 之间`, async () => {
      const w = await itemsWorld(testDb().db, 'f438seq');
      const r = reader(w);
      const x = await orgWithSequence(w, `X${uniqueSuffix()}`, w.a, 30);
      const y = await orgWithSequence(w, `Y${uniqueSuffix()}`, w.b, 10);
      const z = await orgWithSequence(w, `Z${uniqueSuffix()}`, w.b, 50);
      const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
      // 两个入口都只给新上级与是否新增任职，不给 displayOrder
      const body = { entry, adjustType: 2, targetOrgId: x, parent: { orgId: w.b }, addEmployment: false };
      const created = (await w.item(view.id, body)).items.at(-1)!;
      expect(created).toMatchObject({ targetOrgId: x, parentOrgId: w.b, displayOrder: null });

      const roots = (await r.preview(view.id)).roots;
      const under = (orgId: string) => roots.find((root) => root.orgId === orgId)!.children.map((n) => n.orgId);
      expect(under(w.b)).toEqual([y, x, z]);
      expect(under(w.a)).not.toContain(x);
    });
  }
});
