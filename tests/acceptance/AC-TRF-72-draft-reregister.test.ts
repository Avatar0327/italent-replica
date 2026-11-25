/**
 * AC-TRF-72（F-036-S6 第 2 轮，设计 §4.4.2 / §4.6 / §5.3）：草稿改期、改部门要按新前驱重新登记策略，逐层判适用性，
 * 保存值与来源行出自同一折叠结果；本次确实改选的值原样保留，同值回传按 DEC-977 不当作新输入；
 * 提交与同键命令重放在返回台账缓存前复判适用性（J5），只读、不追加来源行。
 * J3“职位必须属于任职部门”由测试注入（真实版由 #99 承接）。
 */
import { useTestDb } from '@italent/testkit';
import { registerFieldApplicability } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearInjected,
  createTransfer,
  deferralWorld,
  directTransfer,
  injectJ3,
  ledger,
  patchBusiness,
  type DeferralWorld,
  type LedgerRow,
} from './AC-EMP-27-deferral-support.js';

const database = useTestDb();
const POSITION = 'preset:positionId';

afterEach(clearInjected);

const rowsOf = (w: DeferralWorld, id: string) => ledger(w, id, [POSITION]);
const decisions = (rows: LedgerRow[]) => rows.filter((row) => row.kind === 'fallback' || row.kind === 'restore');
const savedPosition = async (w: DeferralWorld, id: string) => (await w.business(id)).fields.positionId ?? null;

async function patch(w: DeferralWorld, id: string, body: Record<string, unknown>) {
  const response = await patchBusiness(w, id, body);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 草稿在 A 部门继承职位 P；10-18 另有一条前驱（B 部门 Q 职位）。 */
async function draftWithLateral(label: string, lateralFields?: (w: DeferralWorld) => Record<string, unknown>) {
  const w = await deferralWorld(database().db, label, 'inherit');
  const draft = await createTransfer(w, 'application', '2026-10-10', { departmentId: w.from.id });
  const lateral = await directTransfer(
    w,
    '2026-10-18',
    lateralFields?.(w) ?? { departmentId: w.to.id, positionId: w.target.id },
  );
  injectJ3(w);
  return { w, draft, lateral };
}

describe('AC-TRF-72 P2-1 草稿改期按新前驱重新登记', () => {
  it('①挂起的继承职位 + 改期到新前驱（B/Q）之后：登记新的继承 Q，职位取 Q', async () => {
    const { w, draft, lateral } = await draftWithLateral('f036s6-r2-rereg-1');
    await patch(w, draft.id, { fields: { departmentId: w.to.id } });
    expect(await savedPosition(w, draft.id)).toBeNull();

    await patch(w, draft.id, { effectiveDate: '2026-11-15' });
    const inherits = (await rowsOf(w, draft.id)).filter((row) => row.kind === 'inherit');
    expect(inherits.at(-1)).toMatchObject({ value: w.target.id, source: lateral.id });
    expect(await savedPosition(w, draft.id)).toBe(w.target.id);
  });

  it('②仍适用的 HR 覆盖职位 + 改期到新前驱：覆盖值保留，新继承值判不适用并回落', async () => {
    const { w, draft } = await draftWithLateral('f036s6-r2-rereg-2');
    await patch(w, draft.id, { fields: { positionId: w.sibling.id } });
    const override = (await rowsOf(w, draft.id)).find((row) => row.kind === 'hr-input')!;

    await patch(w, draft.id, { effectiveDate: '2026-11-15' });
    const rows = await rowsOf(w, draft.id);
    const fresh = rows.filter((row) => row.kind === 'inherit').at(-1)!;
    expect(fresh).toMatchObject({ value: w.target.id });
    expect(await savedPosition(w, draft.id)).toBe(w.sibling.id);
    const cut = decisions(rows).filter((row) => row.kind === 'fallback');
    expect(cut.map((row) => row.refSeq)).toEqual([fresh.seq]);
    expect(cut.map((row) => row.refSeq)).not.toContain(override.seq);
  });

  it('③新旧前驱的职位同为 P：继承行重新指向新前驱，值与保存值不变', async () => {
    const { w, draft, lateral } = await draftWithLateral('f036s6-r2-rereg-3', (world) => ({
      departmentId: world.from.id,
      place: '新地点',
    }));
    const before = (await rowsOf(w, draft.id)).filter((row) => row.kind === 'inherit').at(-1)!;
    expect(before).toMatchObject({ value: w.position.id, source: w.hire.id });

    await patch(w, draft.id, { effectiveDate: '2026-11-15' });
    const after = (await rowsOf(w, draft.id)).filter((row) => row.kind === 'inherit').at(-1)!;
    expect(after).toMatchObject({ value: w.position.id, source: lateral.id });
    expect(await savedPosition(w, draft.id)).toBe(w.position.id);
  });
});

describe('AC-TRF-72 P2-1 整版同值回传（DEC-977）', () => {
  it('④HR 整版带回同值职位 P2 并把部门改到 B：不算新输入，覆盖值按适用性回落，200', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-resend', 'inherit');
    injectJ3(w);
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    await patch(w, draft.id, { fields: { positionId: w.sibling.id } });
    const before = await rowsOf(w, draft.id);
    const override = before.find((row) => row.kind === 'hr-input')!;
    const inherit = before.find((row) => row.kind === 'inherit')!;

    const resent = await patchBusiness(w, draft.id, {
      fields: { departmentId: w.to.id, positionId: w.sibling.id },
    });
    expect(resent.status, await resent.clone().text()).toBe(200);
    const rows = await rowsOf(w, draft.id);
    expect(rows.filter((row) => row.kind === 'hr-input')).toHaveLength(1);
    expect(
      decisions(rows)
        .map((row) => [row.kind, row.refSeq])
        .sort(),
    ).toEqual(
      [
        ['fallback', inherit.seq],
        ['fallback', override.seq],
      ].sort(),
    );
    expect(await savedPosition(w, draft.id)).toBeNull();
  });
});

describe('AC-TRF-72 P2-4 提交与命令重放复判适用性（J5）', () => {
  const submit = (w: DeferralWorld, id: string, idempotencyKey: string, ifMatch: number) =>
    w.session.request('POST', `/businesses/${id}/submit`, { ifMatch, body: {}, idempotencyKey });

  it('首次提交与同键重放都调用适用性谓词，来源行不增加', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-j5', 'inherit');
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    let calls = 0;
    clearInjected();
    const off = registerFieldApplicability(POSITION, () => {
      calls += 1;
      return true;
    });
    try {
      const revision = (await w.business(draft.id)).revision;
      const origins = (await ledger(w, draft.id)).length;
      const first = await submit(w, draft.id, 'f036s6-r2-j5-key', revision);
      expect(first.status, await first.clone().text()).toBe(200);
      expect(calls).toBeGreaterThan(0);
      expect((await ledger(w, draft.id)).length).toBe(origins);

      const afterFirst = calls;
      const replay = await submit(w, draft.id, 'f036s6-r2-j5-key', revision);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(calls).toBeGreaterThan(afterFirst);
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });

  it('保存值此刻已不适用：提交返回 409，状态与来源行都不变', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-j5-stale', 'inherit');
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    let applies = true;
    clearInjected();
    const off = registerFieldApplicability(POSITION, () => applies);
    try {
      const current = await w.business(draft.id);
      const origins = (await ledger(w, draft.id)).length;
      applies = false;
      const response = await submit(w, draft.id, 'f036s6-r2-j5-stale-key', current.revision);
      expect(response.status, await response.clone().text()).toBe(409);
      expect((await w.business(draft.id)).status).toBe(current.status);
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });
});
