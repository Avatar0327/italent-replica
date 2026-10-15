/**
 * BE-2a DEC-138 / DEC-139：入职日不早于所选部门的设立日期，部门在入职日起整个时段未停用；
 * 添加待入职、编辑待入职、办理入职、入职接口共用同一入口，提示语照搬原站（34 §8 / §9，W-433～438）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedLegacyOrgDeactivation, type ActivationWorld } from './AC-TRF-activation-support.js';
import {
  addHire,
  addPending,
  businessRevision,
  disableOrg,
  entryAction,
  entryRecords,
  entryWorld,
  hireBody,
} from './AC-EN-BE2a-support.js';

const testDb = useTestDb();

const earliest = (date: string, name: string, founded: string) =>
  `入职日期（${date}）不能早于任职部门【${name}】的最早生效日期（${founded}），请检查修改入职日期或通过修改部门的设立日期来调整部门最早生效日期`;

describe('BE-2a DEC-138 入职日不得早于部门设立日', () => {
  it.each([
    ['添加待入职', { pendingEntry: true }],
    ['直接入职', {}],
    ['入职申请', { mode: 'application' }],
  ])('%s：入职日早于部门设立日被拒，整笔不落库', async (_name, extra) => {
    const w = await entryWorld(testDb().db, `be2a-founded-${extra.mode ?? Object.keys(extra).length}`);
    const employee = await w.session.employee('设立日合成员工');
    const response = await addHire(w.session, employee, hireBody(w.org.id, '2025-12-31', extra));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: earliest('2025-12-31', w.org.name, '2026-01-01') },
    });
    expect(await entryRecords(w, employee.id)).toEqual([]);
  });

  it('设立日当天可入职', async () => {
    const w = await entryWorld(testDb().db, 'be2a-founded-day');
    const { employee } = await addPending(w, '2026-01-01');
    expect(await entryRecords(w, employee.id)).toHaveLength(1);
  });

  it('编辑待入职：改到设立日更晚的部门被拒（同一提示），不改动记录', async () => {
    const w = await entryWorld(testDb().db, 'be2a-founded-edit');
    const late = await w.session.org('晚设立部门', { establishedOn: '2026-11-01' });
    const { employee, recordId } = await addPending(w, '2026-10-10');
    const response = await w.session.request('PATCH', `/records/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body: { fields: { departmentId: late.id } },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: earliest('2026-10-10', '晚设立部门', '2026-11-01') },
    });
    expect((await entryRecords(w, employee.id))[0]!.fields).toMatchObject({ departmentId: w.org.id });
  });
});

describe('BE-2a DEC-139 部门在入职日起整个时段未停用', () => {
  it('入职日已落在停用期内 / 入职日在停用日之前：两种提示语', async () => {
    const w = await entryWorld(testDb().db, 'be2a-disabled-msg');
    await disableOrg(w, w.org.id, w.org.revision, '2026-10-05');
    const employee = await w.session.employee('停用合成员工');
    const during = await addHire(w.session, employee, hireBody(w.org.id, '2026-10-10', { pendingEntry: true }));
    expect(during.status).toBe(400);
    expect(await during.json()).toMatchObject({
      error: { message: `任职部门【${w.org.name}】在入职日期（2026-10-10）时为停用状态，请检查` },
    });
    const before = await addHire(w.session, employee, hireBody(w.org.id, '2026-10-01', { pendingEntry: true }));
    expect(before.status).toBe(400);
    expect(await before.json()).toMatchObject({
      error: { message: `任职部门【${w.org.name}】已被停用（停用日期：2026-10-05），请检查` },
    });
    expect(await entryRecords(w, employee.id)).toEqual([]);
  });

  it('办理入职：待入职保存后部门又排定停用，办理时拒绝，仍为待入职', async () => {
    const w = await entryWorld(testDb().db, 'be2a-disabled-complete');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    await seedLegacyOrgDeactivation(
      { db: w.db, session: w.session, to: w.org } as unknown as ActivationWorld,
      '2026-10-20',
    );
    const response = await entryAction(w, recordId, 'complete', { probation: false });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: `任职部门【${w.org.name}】已被停用（停用日期：2026-10-20），请检查` },
    });
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 1 });
  });
});
