/**
 * BE-11c-b 第 2 轮 P2-3（R2-T08 §2.5 / §6.3 路由 8、9）：调动行的基线刷新。
 * 员工任职在建行后被外部改动 → 提交 409 BASELINE_CHANGED；单行 `POST …/items/transfer/:itemId/rebase` 与整单
 * `POST …/rebase` 把调动行基线（现行任职、员工 revision）刷到当前值，按申请人当前权限逐行重判（与保存同一条授权链），
 * revision + 1、每行一条明细审计；刷新后即可提交。刷新只确认版本，不豁免业务约束。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { bodyOf, expectError, onlyPeople } from './AC-OA-head-support.js';

const testDb = useTestDb();

async function setup(label: string) {
  const w = await transferWorld(testDb().db, label);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  const [first, second] = [await w.staff(w.a), await w.staff(w.b)];
  const rows = [await w.seed(view.id, first), await w.seed(view.id, second)];
  const touch = (employeeId: string) =>
    w.inTenant((tx) =>
      tx.execute(sql`UPDATE employment_employees SET revision = revision + 1
        WHERE tenant_id = ${w.tenant.id} AND id = ${employeeId}::uuid`),
    );
  const revisions = async () => (await w.transferRows(view.id)).map((row) => row.base_employee_revision);
  const rebaseRow = (itemId: string) => w.rebaseItem(view.id, itemId, undefined, 'transfer');
  return { w, view, people: [first, second], rows, touch, revisions, rebaseRow };
}

describe('P2-3 调动行刷新基线', () => {
  it('冲突 → 整单刷新 → 重提：外部改动使提交 409，刷新后基线取当前值、revision + 1、每行一条审计，再提交成功', async () => {
    const { w, view, people, rows, touch, revisions } = await setup('r2-rebase-whole');
    await touch(people[0]!);
    await touch(people[1]!);
    const stale = await revisions();

    const conflict = await w.submit(view.id);
    await expectError(conflict, 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await bodyOf(conflict)).error?.details?.items).toEqual(
      expect.arrayContaining(rows.map((itemId) => ({ section: 'transfer', itemId }))),
    );

    const before = (await w.stored(view.id))!.revision;
    const res = await w.rebaseAll(view.id);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await revisions()).toEqual(stale.map((revision) => revision + 1));
    expect((await w.stored(view.id))!.revision).toBe(before + 1);
    expect((await w.transferAudits(view.id)).filter((action) => action === 'org-adjustment.rebase')).toHaveLength(2);
    await w.submitted(view.id);
  });

  it('单行刷新：只动这一行的基线，另一行仍旧过期；返回该行', async () => {
    const { w, view, people, rows, touch, revisions, rebaseRow } = await setup('r2-rebase-one');
    const [firstBase, secondBase] = await revisions();
    await touch(people[0]!);
    await touch(people[1]!);

    const res = await rebaseRow(rows[0]!);

    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { items: { id: string; baseEmployeeRevision: number }[] };
    expect(body.items).toMatchObject([{ id: rows[0], baseEmployeeRevision: firstBase! + 1 }]);
    expect(await revisions()).toEqual([firstBase! + 1, secondBase]);
    const conflict = await w.submit(view.id);
    await expectError(conflict, 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await bodyOf(conflict)).error?.details?.items).toEqual([{ section: 'transfer', itemId: rows[1] }]);
  });

  it('员工不在申请人任职范围：单行 404、整单被拒，基线与 revision 都不动', async () => {
    const { w, view, people, rows, touch, revisions, rebaseRow } = await setup('r2-rebase-scope');
    await touch(people[0]!);
    await touch(people[1]!);
    w.access.employment = onlyPeople(w.a, people[0]!); // 第二个员工在范围外
    const before = { revisions: await revisions(), revision: (await w.stored(view.id))!.revision };

    await expectError(await rebaseRow(rows[1]!), 404, 'NOT_FOUND');
    const whole = await w.rebaseAll(view.id);
    expect([403, 404], await whole.clone().text()).toContain(whole.status);

    expect({ revisions: await revisions(), revision: (await w.stored(view.id))!.revision }).toEqual(before);
  });

  it('申请人已失去目标部门字段写权：整单与单行刷新都 403，基线不动', async () => {
    const { w, view, people, rows, touch, revisions, rebaseRow } = await setup('r2-rebase-field');
    await touch(people[0]!);
    const before = await revisions();
    w.access.deniedFields.add('transferItems.departmentId');

    await expectError(await w.rebaseAll(view.id), 403, 'FORBIDDEN');
    await expectError(await rebaseRow(rows[0]!), 403, 'FORBIDDEN');

    expect(await revisions()).toEqual(before);
  });
});
