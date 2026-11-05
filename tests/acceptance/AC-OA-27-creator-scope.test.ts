/**
 * R2-T08 F-414②：读路径的数据范围含“本人创建”（using_user）。写路径经 `authorizeOrgResult` 已按创建人判定，
 * 读路径（详情 / 明细 / 预览共用的披露）原先只比较组织，`using_user` 范围下发起人看不到自己建的组织、
 * 也打不开自己的申请单（创建人缺位 = 一律不放行）。口径：组织的创建人 = 组织新增审计的创建人元数据，
 * 申请单的创建人 = created_by；范围外与不存在仍同一 404（§4.5、F-339 ③）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ModuleScope } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { expectError } from './AC-OA-head-support.js';
import { itemsWorld, rename } from './AC-OA-items-support.js';
import { flatten, reader } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

const createdBy = (creatorId: string): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId }],
});

async function world() {
  const w = await itemsWorld(testDb().db, 'oa27c');
  const other = await w.member('另一位创建人');
  const made = await w.request(other, 'POST', '/api/tenant/org/organizations', {
    ifMatch: 0,
    body: {
      name: `ZZ_他人创建${uniqueSuffix()}`,
      establishedOn: '2020-01-01',
      parents: { admin: { parentId: w.tenant.id } },
    },
  });
  expect(made.status, await made.clone().text()).toBe(201);
  const theirs = ((await made.json()) as { id: string }).id;
  return { w, other, theirs, mine: w.a };
}

describe('AC-OA-27 F-414② 读路径数据范围含 creatorId（发起人视角）', () => {
  it('组织范围为“本人创建”：明细 / 详情分区 / 预览只放行本人创建的组织，他人创建的整行隐去并计数', async () => {
    const { w, theirs, mine } = await world();
    const view = await w.created(w.head({ adjustmentRange: [mine, theirs] }));
    const own = (await w.item(view.id, rename(mine))).items.at(-1)!;
    await w.item(view.id, rename(theirs));
    w.access.org = createdBy(w.hr.id);
    const r = reader(w);

    const items = await r.items(view.id);
    expect(items.items.map((item) => item.id)).toEqual([own.id]);
    expect(items.hiddenRowCount).toBe(1);
    expect((await r.detail(view.id)).sections).toEqual({ org: { count: 1, hiddenRowCount: 1 } });
    const nodes = flatten((await r.preview(view.id)).roots);
    expect(nodes.map((node) => node.orgId).filter(Boolean)).toContain(mine);
    expect(nodes.map((node) => node.orgId)).not.toContain(theirs);
  });

  it('组织范围的创建人是别人：本人建的组织同样被隐去（不是“发起人一律可见”）', async () => {
    const { w, other, theirs, mine } = await world();
    const view = await w.created(w.head({ adjustmentRange: [mine, theirs] }));
    await w.item(view.id, rename(mine));
    const foreign = (await w.item(view.id, rename(theirs))).items.at(-1)!;
    w.access.org = createdBy(other);

    const items = await reader(w).items(view.id);
    expect(items.items.map((item) => item.id)).toEqual([foreign.id]);
    expect(items.hiddenRowCount).toBe(1);
  });

  it('申请单对象范围为“本人创建”：发起人能打开自己的申请单，他人创建的申请单与不存在同一 404', async () => {
    const { w, other } = await world();
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    w.access.main = createdBy(w.hr.id);
    expect((await reader(w).detail(view.id)).id).toBe(view.id);

    w.access.main = createdBy(other);
    const denied = await reader(w).detailRes(view.id);
    await expectError(denied, 404, 'NOT_FOUND');
    const missing = await reader(w).detailRes('00000000-0000-4000-8000-000000000000');
    expect(await denied.clone().json()).toEqual(await missing.clone().json());
  });
});
