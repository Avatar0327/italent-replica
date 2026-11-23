/**
 * AC-TRF-72（机制层，F-036-S6）：字段值的适用性（设计 §4.6、§5.3）。
 * J3“职位必须属于任职部门”的判定由测试注入（真实 HTTP 版由 #99 承接）；这里验证机制：
 * 判定不适用 → 写 fallback 行并退到下层 / 空；判定恢复 → 写 restore 行；覆盖值、继承值、落地解析值各自独立。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFieldApplicability } from '../../apps/api/src/modules/employment/field-origin-store.js';
import {
  createTransfer,
  deferralWorld,
  ledger,
  patchBusiness,
  submitBusiness,
  type DeferralWorld,
  type LedgerRow,
} from './AC-EMP-27-deferral-support.js';

const database = useTestDb();
const POSITION = 'preset:positionId';

const unregister: (() => void)[] = [];
afterEach(() => {
  for (const off of unregister.splice(0)) off();
});

/** 注入 J3“职位必须属于任职部门”的判定；部门仍待定（延迟）时无法判断，返回 undefined。 */
function injectJ3(w: DeferralWorld) {
  const off = registerFieldApplicability(POSITION, (row, candidate) =>
    candidate.deferredFieldCodes.includes('preset:departmentId')
      ? undefined
      : w.orgOf.get(String(row.value)) === candidate.fields.departmentId,
  );
  unregister.push(off);
}

const positionRows = (w: DeferralWorld, id: string) => ledger(w, id, [POSITION]);
const decisions = (rows: LedgerRow[]) => rows.filter((row) => row.kind === 'fallback' || row.kind === 'restore');

async function patch(w: DeferralWorld, id: string, fields: Record<string, unknown>) {
  const response = await patchBusiness(w, id, { fields });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function savedPosition(w: DeferralWorld, id: string) {
  return (await w.business(id)).fields.positionId ?? null;
}

async function land(w: DeferralWorld, draft: { id: string }, date: string) {
  await submitBusiness(w, draft.id);
  await w.approve(draft, '2026-10-01T02:00:00Z');
  const run = await w.runScheduler(`${date}T01:00:00Z`);
  expect(run).toMatchObject({ activated: [draft.id], failed: [] });
  return w.session.record(draft.id, date);
}

describe('AC-TRF-72 继承值：部门改走再改回', () => {
  it('Z1：部门改为 B → 职位 fallback 退到空；改回 A → restore；备注改动不再写判定行', async () => {
    const w = await deferralWorld(database().db, 'f036s6-trf72-z1', 'inherit');
    injectJ3(w);
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    const inherit = (await positionRows(w, draft.id)).find((row) => row.kind === 'inherit');
    expect(inherit).toMatchObject({ value: w.position.id });
    expect(decisions(await positionRows(w, draft.id))).toEqual([]);
    expect(await savedPosition(w, draft.id)).toBe(w.position.id);

    await patch(w, draft.id, { departmentId: w.to.id });
    const away = decisions(await positionRows(w, draft.id));
    expect(away).toHaveLength(1);
    expect(away[0]).toMatchObject({ kind: 'fallback', refSeq: inherit!.seq, version: 2 });
    expect(await savedPosition(w, draft.id)).toBeNull();

    await patch(w, draft.id, { remarks: '只改备注' });
    expect(decisions(await positionRows(w, draft.id))).toHaveLength(1);
    expect(await savedPosition(w, draft.id)).toBeNull();

    await patch(w, draft.id, { departmentId: w.from.id });
    const back = decisions(await positionRows(w, draft.id));
    expect(back.map((row) => row.kind)).toEqual(['fallback', 'restore']);
    expect(back[1]).toMatchObject({ refSeq: inherit!.seq });
    expect(await savedPosition(w, draft.id)).toBe(w.position.id);
  });

  it('Z1 落地：停在 B → 部门 B、职位为空；停在 A → 部门 A、职位取继承值', async () => {
    const w = await deferralWorld(database().db, 'f036s6-trf72-land', 'inherit');
    injectJ3(w);
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    await patch(w, draft.id, { departmentId: w.to.id });
    const atB = await land(w, draft, '2026-11-01');
    expect(atB.fields).toMatchObject({ departmentId: w.to.id, positionId: null });

    // 第一个世界的谓词只认它自己的组织：建第二个世界（含入职落地）之前先注销，免得串到别人的入职记录
    for (const off of unregister.splice(0)) off();
    const other = await deferralWorld(database().db, 'f036s6-trf72-land-a', 'inherit');
    injectJ3(other);
    const back = await createTransfer(other, 'application', '2026-11-01', { departmentId: other.from.id });
    await patch(other, back.id, { departmentId: other.to.id });
    await patch(other, back.id, { departmentId: other.from.id });
    const atA = await land(other, back, '2026-11-01');
    expect(atA.fields).toMatchObject({ departmentId: other.from.id, positionId: other.position.id });
  });
});

describe('AC-TRF-72 同一请求自己输入的字段不判', () => {
  it('Z5：同一次保存改部门并选 B 部门的职位 → 继承值 fallback，新选的职位原样保存', async () => {
    const w = await deferralWorld(database().db, 'f036s6-trf72-z5', 'inherit');
    injectJ3(w);
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    const inherit = (await positionRows(w, draft.id)).find((row) => row.kind === 'inherit')!;
    await patch(w, draft.id, { departmentId: w.to.id, positionId: w.target.id });
    const rows = await positionRows(w, draft.id);
    expect(rows.find((row) => row.kind === 'hr-input')).toMatchObject({ value: w.target.id });
    expect(decisions(rows).map((row) => [row.kind, row.refSeq])).toEqual([['fallback', inherit.seq]]);
    expect(await savedPosition(w, draft.id)).toBe(w.target.id);
  });
});

describe('AC-TRF-72 覆盖值：HR 改选职位后部门改走再改回', () => {
  it('Z3：覆盖值与继承值各写一条 fallback，改回后各写一条 restore，有效值取 HR 选的职位', async () => {
    const w = await deferralWorld(database().db, 'f036s6-trf72-z3', 'inherit');
    injectJ3(w);
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    await patch(w, draft.id, { positionId: w.sibling.id });
    const rows = await positionRows(w, draft.id);
    const inherit = rows.find((row) => row.kind === 'inherit')!;
    const override = rows.find((row) => row.kind === 'hr-input')!;
    expect(override).toMatchObject({ value: w.sibling.id });
    expect(decisions(rows)).toEqual([]);

    await patch(w, draft.id, { departmentId: w.to.id });
    const away = decisions(await positionRows(w, draft.id));
    expect(away.map((row) => [row.kind, row.refSeq]).sort()).toEqual(
      [
        ['fallback', inherit.seq],
        ['fallback', override.seq],
      ].sort(),
    );
    expect(await savedPosition(w, draft.id)).toBeNull();

    await patch(w, draft.id, { departmentId: w.from.id });
    const back = decisions(await positionRows(w, draft.id)).filter((row) => row.kind === 'restore');
    expect(back.map((row) => row.refSeq).sort()).toEqual([inherit.seq, override.seq].sort());
    expect(await savedPosition(w, draft.id)).toBe(w.sibling.id);
    const landed = await land(w, draft, '2026-11-01');
    expect(landed.fields).toMatchObject({ departmentId: w.from.id, positionId: w.sibling.id });
  });
});

describe('AC-TRF-72 落地解析值：覆盖值被退回后落地取前驱', () => {
  it.each(['不改备注', '中间改一次备注'])(
    'Z4：延迟职位 → HR 选 A 部门的职位 → 部门改 B → 另有 B/Q 调动先落地（%s）',
    async (variant) => {
      const w = await deferralWorld(database().db, `f036s6-trf72-z4-${variant}`, 'open');
      injectJ3(w);
      const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
      expect(w.shape).toBe('open');
      await patch(w, draft.id, { positionId: w.sibling.id });
      const override = (await positionRows(w, draft.id)).find((row) => row.kind === 'hr-input')!;
      await patch(w, draft.id, { departmentId: w.to.id });
      const fallback = decisions(await positionRows(w, draft.id));
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toMatchObject({ kind: 'fallback', refSeq: override.seq });
      if (variant === '中间改一次备注') {
        await patch(w, draft.id, { remarks: '只改备注' });
        expect(decisions(await positionRows(w, draft.id))).toHaveLength(1);
      }

      // HR 另办一条 10-18 的调动：落在 B 部门 Q 职位，先于申请落地
      const lateral = await w.session.business(
        w.employee.id,
        {
          kind: 'transfer',
          mode: 'direct',
          effectiveDate: '2026-10-18',
          fields: { departmentId: w.to.id, positionId: w.target.id },
        },
        (await w.session.getEmployee(w.employee.id)).revision,
      );
      expect(lateral.record).toMatchObject({ fields: { departmentId: w.to.id, positionId: w.target.id } });

      const landed = await land(w, draft, '2026-11-01');
      expect(landed.fields).toMatchObject({ departmentId: w.to.id, positionId: w.target.id });
      const resolved = (await positionRows(w, draft.id)).filter((row) => row.kind === 'resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ value: w.target.id, source: lateral.id, record: draft.id });
    },
  );
});
