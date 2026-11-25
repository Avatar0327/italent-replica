/**
 * AC-TRF-72（F-036-S6 第 2 轮，设计 §5.3）：落地先定有效部门，再判职位覆盖值，最后解析仍待定的职位，
 * 并登记最终的解析结果与原因。造数据全走真实入口：向后更新走 PATCH /records/:id，前驱走直接调动。
 * J3“职位必须属于任职部门”由测试注入（真实版由 #99 承接）。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearInjected,
  createTransfer,
  deferralWorld,
  directTransfer,
  editRecord,
  injectJ3,
  ledger,
  patchBusiness,
  payloadVersions,
  submitBusiness,
  type DeferralWorld,
} from './AC-EMP-27-deferral-support.js';

const database = useTestDb();
const POSITION = 'preset:positionId';

afterEach(clearInjected);

async function land(w: DeferralWorld, draft: { id: string }, date: string) {
  await submitBusiness(w, draft.id);
  await w.approve(draft, '2026-10-01T02:00:00Z');
  const run = await w.runScheduler(`${date}T01:00:00Z`);
  expect(run).toMatchObject({ activated: [draft.id], failed: [] });
  return w.session.record(draft.id, date);
}

describe('AC-TRF-72 落地：覆盖值失效后继续解析延迟职位', () => {
  it('向后更新写入的 P2 随部门解析为 B 而挂起：落成 B/Q，职位记 resolved(Q)，P2 保留为可恢复的候选', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-land-a', 'open');
    // 部门 A、职位为空的前驱：向后更新才能命中草稿里待定（空）的职位
    const base = await directTransfer(w, '2026-09-15', { departmentId: w.from.id, positionId: null });
    const draft = await createTransfer(w, 'application', '2026-11-01', {});
    await editRecord(w, base.id, { positionId: w.sibling.id });
    expect(await payloadVersions(w, draft.id)).toEqual([1, 2]);
    const override = (await ledger(w, draft.id, [POSITION])).find((row) => row.kind === 'forward-update')!;
    expect(override).toMatchObject({ value: w.sibling.id, version: 2 });
    // 随后 B/Q 成为落地前驱
    const lateral = await directTransfer(w, '2026-10-18', { departmentId: w.to.id, positionId: w.target.id });
    injectJ3(w);

    const landed = await land(w, draft, '2026-11-01');
    expect(landed.fields).toMatchObject({ departmentId: w.to.id, positionId: w.target.id });
    const rows = await ledger(w, draft.id, [POSITION]);
    expect(rows.filter((row) => row.kind === 'resolved')).toEqual([
      expect.objectContaining({ value: w.target.id, source: lateral.id, record: draft.id }),
    ]);
    expect(rows.filter((row) => row.kind === 'fallback')).toEqual([
      expect.objectContaining({ refSeq: override.seq, reason: 'cross-department' }),
    ]);
  });

  it('延迟职位解析出的 P 不属于有效部门 B：记录职位为空，解析行值为空并带 cross-department 原因', async () => {
    // 职位延迟（表单不带出职位）、部门显式选 B；落地前驱是入职记录 A/P，P 不属于 B
    const w = await deferralWorld(database().db, 'f036s6-r2-land-b', 'position');
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.to.id });
    const lateral = w.hire;
    injectJ3(w);

    const landed = await land(w, draft, '2026-11-01');
    expect(landed.fields).toMatchObject({ departmentId: w.to.id, positionId: null });
    const rows = await ledger(w, draft.id, [POSITION]);
    expect(rows.filter((row) => row.kind === 'resolved')).toEqual([
      expect.objectContaining({ value: null, reason: 'cross-department', source: lateral.id, record: draft.id }),
    ]);
    expect(rows.filter((row) => row.kind === 'fallback')).toEqual([]);
  });

  it('HR 覆盖职位 P2 停在 B 落地：部门 B、职位空；覆盖与继承各自留一条回落，不写解析值', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-land-c', 'inherit');
    injectJ3(w);
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    for (const fields of [{ positionId: w.sibling.id }, { departmentId: w.to.id }]) {
      const response = await patchBusiness(w, draft.id, { fields });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const before = await ledger(w, draft.id, [POSITION]);
    const landed = await land(w, draft, '2026-11-01');
    expect(landed.fields).toMatchObject({ departmentId: w.to.id, positionId: null });
    const rows = await ledger(w, draft.id, [POSITION]);
    expect(rows.filter((row) => row.kind === 'fallback')).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'resolved')).toEqual([]);
    expect(rows.map((row) => row.seq)).toEqual(before.map((row) => row.seq));
  });

  it('向后更新写入的 P2 停在 B、没有新前驱：落成 B / 空，解析行带 cross-department，P2 仍是候选', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-land-d', 'open');
    const base = await directTransfer(w, '2026-09-15', { departmentId: w.from.id, positionId: null });
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    await editRecord(w, base.id, { positionId: w.sibling.id });
    injectJ3(w);
    const moved = await patchBusiness(w, draft.id, { fields: { departmentId: w.to.id } });
    expect(moved.status, await moved.clone().text()).toBe(200);

    const landed = await land(w, draft, '2026-11-01');
    expect(landed.fields).toMatchObject({ departmentId: w.to.id, positionId: null });
    const rows = await ledger(w, draft.id, [POSITION]);
    const override = rows.find((row) => row.kind === 'forward-update')!;
    expect(rows.filter((row) => row.kind === 'resolved')).toEqual([
      expect.objectContaining({ value: null, reason: 'cross-department', source: base.id, record: draft.id }),
    ]);
    // 覆盖值只有一条回落（部门改走时写的），落地不再重复回落，也没有恢复
    expect(rows.filter((row) => row.kind === 'fallback').map((row) => row.refSeq)).toEqual([override.seq]);
    expect(rows.filter((row) => row.kind === 'restore')).toEqual([]);
  });
});
