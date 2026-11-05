/**
 * R2-T08 F-414②（返工）：申请单对象范围为“本人创建”（using_user）时，列表与详情必须同一口径。
 * 详情 / 预览已按 created_by 放行，列表原先只给 scopeSql 传审批主体组织，using_user 项因缺创建人列恒为假：
 * 发起人“列表里没有自己的单据、拿着链接却能打开”。口径：先按范围过滤再分页，total 同口径（§4.5）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ModuleScope } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { expectError } from './AC-OA-head-support.js';
import { itemsWorld } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';

const testDb = useTestDb();

const createdBy = (creatorId: string): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId }],
});

describe('AC-OA-27 F-414② 列表与详情同一口径：申请单对象范围为“本人创建”', () => {
  it('列表只含本人创建的单据，先过滤再分页，total 同口径；详情同样只放行本人创建的单据', async () => {
    const w = await itemsWorld(testDb().db, 'oa27l');
    const other = await w.member('另一位创建人');
    const r = reader(w);
    const created: { id: string; mine: boolean }[] = [];
    // 本人 / 他人交错创建，时间递增；审批主体组织都是同一个，不靠组织区分
    for (const [index, mine] of [true, false, true, false, true].entries()) {
      w.setNow(`2026-10-0${index + 1}T01:00:00.000Z`);
      const res = await w.create(w.head(), mine ? w.hr.id : other);
      expect(res.status, await res.clone().text()).toBe(201);
      created.push({ id: ((await res.json()) as { id: string }).id, mine });
    }
    const own = created.filter((item) => item.mine).map((item) => item.id);
    const foreign = created.filter((item) => !item.mine).map((item) => item.id);
    expect((await r.list()).total).toBe(5);

    w.access.main = createdBy(w.hr.id);
    const first = await r.list('page=1&pageSize=2');
    const second = await r.list('page=2&pageSize=2');
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual([...own].reverse());

    for (const id of own) expect((await r.detail(id)).id).toBe(id);
    for (const id of foreign) await expectError(await r.detailRes(id), 404, 'NOT_FOUND');

    w.access.main = createdBy(other);
    const theirs = await r.list();
    expect(theirs.total).toBe(2);
    expect(theirs.items.map((row) => row.id)).toEqual([...foreign].reverse());
  });
});
