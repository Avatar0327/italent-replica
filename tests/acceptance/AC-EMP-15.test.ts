/**
 * AC-EMP-15（Q-M0-58 附带取证，`19` §3.1 W-443；照搬原站）：调整直线经理会形成员工之间的循环汇报时拒绝保存，
 * 提示“存在以下循环汇报，请修改。F1 的直线经理汇报线循环：F1→F2→F1”。校验在任职写入的公共路径上，
 * 普通任职业务、编辑任职、审批申请与职位变更同步直线经理都覆盖；按版本的生效日（及其有效期）判断汇报链。
 * 向后更新的后续记录若会成环，该字段跳过（与引用值不可用同一处理），主记录照常保存。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld, type HiredEmployee, type OrgPeopleWorld } from './AC-ORG-people-support.js';

const testDb = useTestDb();
const SEPT = '2026-09-01';

async function people(label: string) {
  const world = await orgPeopleWorld(testDb().db, label);
  const department = await world.org('汇报线部门', world.tenant.id, { establishedOn: SEPT });
  const hire = (name: string, fields: Record<string, unknown> = {}) =>
    world.hire(name, { departmentId: department.id, ...fields }, SEPT);
  return { world, department, hire };
}

async function revisionOf(world: OrgPeopleWorld, employeeId: string) {
  return (await world.getEmployee(employeeId)).revision;
}

async function businessRevision(world: OrgPeopleWorld, businessId: string) {
  const response = await world.request('GET', `/businesses/${businessId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { revision: number }).revision;
}

function editManager(world: OrgPeopleWorld, recordId: string, revision: number, managerId: string) {
  return world.request('PATCH', `/records/${recordId}`, {
    ifMatch: revision,
    body: { fields: { directManagerId: managerId } },
  });
}

/** E 在 10-02 先后有 A、B 两条记录（A 被同日在后的 B 取代、有效区间为空）；M 自 10-03 起汇报给 E。 */
async function sameDayChain(label: string, managerOfB: 'x' | 'none') {
  const { world, hire } = await people(label);
  const x = await hire('经理X');
  const m = await hire('下属M');
  const e = await hire('员工E');
  const created = async (target: HiredEmployee, effectiveDate: string, fields: Record<string, unknown>) => {
    const response = await transfer(world, target, await revisionOf(world, target.id), { effectiveDate, fields });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const a = await created(e, '2026-10-02', { remarks: '同日在前A' });
  const b = await created(e, '2026-10-02', managerOfB === 'x' ? { directManagerId: x.id } : { remarks: '同日在后B' });
  await created(m, '2026-10-03', { directManagerId: e.id });
  return { world, x, m, e, a, b };
}

function transfer(world: OrgPeopleWorld, employee: HiredEmployee, revision: number, body: Record<string, unknown>) {
  return world.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: revision,
    body: { kind: 'transfer', mode: 'direct', ...body },
  });
}

async function expectCycle(response: Response, message: string) {
  expect(response.status, await response.clone().text()).toBe(400);
  const body = (await response.json()) as { error: { code: string; message: string; details: unknown } };
  expect(body.error).toMatchObject({
    code: 'VALIDATION_FAILED',
    details: { reason: 'REPORTING_CYCLE', fields: { directManagerId: expect.any(String) } },
  });
  expect(body.error.message).toBe(message);
}

describe('AC-EMP-15 调整直线经理不得形成循环汇报', () => {
  it('两人互为经理：F1 的经理是 F2 时，再把 F2 的经理设为 F1 被拒，任职不变', async () => {
    const { world, hire } = await people('emp15pair');
    const f2 = await hire('F2');
    const f1 = await hire('F1', { directManagerId: f2.id });
    const response = await transfer(world, f2, await revisionOf(world, f2.id), {
      effectiveDate: '2026-10-02',
      fields: { directManagerId: f1.id },
    });
    await expectCycle(response, '存在以下循环汇报，请修改。F2 的直线经理汇报线循环：F2→F1→F2');
    expect((await world.records(f2.id, '2026-10-02')).map((record) => record.kind)).toEqual(['hire']);
  });

  it('多级汇报链成环、员工自任经理同样被拒', async () => {
    const { world, hire } = await people('emp15chain');
    const a = await hire('甲');
    const b = await hire('乙', { directManagerId: a.id });
    const c = await hire('丙', { directManagerId: b.id });
    await expectCycle(
      await transfer(world, a, await revisionOf(world, a.id), {
        effectiveDate: '2026-10-02',
        fields: { directManagerId: c.id },
      }),
      '存在以下循环汇报，请修改。甲 的直线经理汇报线循环：甲→丙→乙→甲',
    );
    await expectCycle(
      await transfer(world, b, await revisionOf(world, b.id), {
        effectiveDate: '2026-10-02',
        fields: { directManagerId: b.id },
      }),
      '存在以下循环汇报，请修改。乙 的直线经理汇报线循环：乙→乙',
    );
  });

  it('按版本生效日判断：生效日汇报链已改走别处时不成环，可以保存', async () => {
    const { world, hire } = await people('emp15date');
    const x = await hire('另一经理');
    const f2 = await hire('F2');
    const f1 = await hire('F1', { directManagerId: f2.id });
    const moved = await transfer(world, f1, await revisionOf(world, f1.id), {
      effectiveDate: '2026-10-10',
      fields: { directManagerId: x.id },
    });
    expect(moved.status, await moved.clone().text()).toBe(201);
    await expectCycle(
      await transfer(world, f2, await revisionOf(world, f2.id), {
        effectiveDate: '2026-10-05',
        fields: { directManagerId: f1.id },
      }),
      '存在以下循环汇报，请修改。F2 的直线经理汇报线循环：F2→F1→F2',
    );
    const later = await transfer(world, f2, await revisionOf(world, f2.id), {
      effectiveDate: '2026-10-15',
      fields: { directManagerId: f1.id },
    });
    expect(later.status, await later.clone().text()).toBe(201);
  });

  it('新版本有效期内汇报链才成环（他人已排定的未来记录）同样被拒，并给出成环起始日', async () => {
    const { world, hire } = await people('emp15window');
    const x = await hire('原经理');
    const f2 = await hire('F2');
    const f1 = await hire('F1', { directManagerId: x.id });
    const future = await transfer(world, f1, await revisionOf(world, f1.id), {
      effectiveDate: '2026-10-20',
      fields: { directManagerId: f2.id },
    });
    expect(future.status, await future.clone().text()).toBe(201);
    const response = await transfer(world, f2, await revisionOf(world, f2.id), {
      effectiveDate: '2026-10-05',
      fields: { directManagerId: f1.id },
    });
    await expectCycle(response, '存在以下循环汇报，请修改。F2 的直线经理汇报线循环：F2→F1→F2（自 2026-10-20 起）');
    const bounded = await transfer(world, f2, await revisionOf(world, f2.id), {
      effectiveDate: '2026-10-15',
      fields: { directManagerId: x.id },
    });
    expect(bounded.status, await bounded.clone().text()).toBe(201);
    const inWindow = await transfer(world, f2, await revisionOf(world, f2.id), {
      effectiveDate: '2026-10-05',
      fields: { directManagerId: f1.id },
    });
    expect(inWindow.status, await inWindow.clone().text()).toBe(201);
  });

  it('编辑任职改直线经理、提交审批申请也走同一校验', async () => {
    const { world, hire } = await people('emp15edit');
    const f2 = await hire('F2');
    const f1 = await hire('F1', { directManagerId: f2.id });
    const edited = await world.request('PATCH', `/records/${f2.recordId}`, {
      ifMatch: 1,
      body: { fields: { directManagerId: f1.id } },
    });
    await expectCycle(edited, '存在以下循环汇报，请修改。F2 的直线经理汇报线循环：F2→F1→F2');
    const application = await transfer(world, f2, await revisionOf(world, f2.id), {
      mode: 'application',
      effectiveDate: '2026-10-20',
      fields: { directManagerId: f1.id },
    });
    await expectCycle(application, '存在以下循环汇报，请修改。F2 的直线经理汇报线循环：F2→F1→F2');
    expect((await world.record(f2.recordId)).fields).toMatchObject({ directManagerId: null });
  });

  it('职位变更同步直线经理会成环时整单拒绝（W-443），职位与任职都不变', async () => {
    const { world, department, hire } = await people('emp15sync');
    const post = await world.job('posts', '成环职务', { startDate: SEPT });
    const position = (name: string, extra: Record<string, unknown> = {}) =>
      world.job('positions', name, { orgId: department.id, postId: post.id, startDate: SEPT, ...extra });
    const newParent = await position('新上级职位');
    const target = await position('本职位');
    const employee = await hire('本职位员工', { positionId: target.id });
    const manager = await hire('新上级唯一在岗', { positionId: newParent.id, directManagerId: employee.id });
    const response = await world.call('PATCH', `job/positions/${target.id}`, {
      ifMatch: target.revision,
      body: {
        parents: { admin: { parentId: newParent.id } },
        effectiveDate: '2026-10-02',
        adjustEmployeeDirectManager: true,
      },
    });
    await expectCycle(
      response,
      '存在以下循环汇报，请修改。本职位员工 的直线经理汇报线循环：本职位员工→新上级唯一在岗→本职位员工',
    );
    const current = await world.call('GET', `job/positions/${target.id}?asOf=2026-10-02`);
    expect(await current.json()).toMatchObject({ revision: target.revision, directParentId: null });
    expect((await world.records(employee.id, '2026-10-02')).map((record) => record.kind)).toEqual(['hire']);
    expect((await world.records(manager.id, '2026-10-02')).map((record) => record.kind)).toEqual(['hire']);
  });

  it('向后更新：后续记录改成新经理会成环时只跳过该字段，主记录照常保存', async () => {
    const { world, hire } = await people('emp15forward');
    const x = await hire('原经理');
    const m = await hire('新经理');
    const e = await hire('员工', { directManagerId: x.id });
    const eFuture = await transfer(world, e, await revisionOf(world, e.id), {
      effectiveDate: '2026-10-20',
      fields: { directManagerId: x.id, remarks: '十月二十日调动' },
    });
    expect(eFuture.status, await eFuture.clone().text()).toBe(201);
    const futureRecordId = ((await eFuture.json()) as { id: string }).id;
    const mFuture = await transfer(world, m, await revisionOf(world, m.id), {
      effectiveDate: '2026-10-20',
      fields: { directManagerId: e.id },
    });
    expect(mFuture.status, await mFuture.clone().text()).toBe(201);
    const input = { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { directManagerId: m.id } };
    const preview = await world.request('POST', `/employees/${e.id}/forward-update-preview`, { body: input });
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(((await preview.json()) as { skipped: unknown[] }).skipped).toContainEqual({
      businessId: futureRecordId,
      reason: 'REPORTING_CYCLE',
      fields: ['directManagerId'],
    });
    const saved = await world.request('POST', `/employees/${e.id}/businesses`, {
      ifMatch: await revisionOf(world, e.id),
      body: input,
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect((await world.records(e.id, '2026-10-05')).find((record) => record.isCurrent)?.fields).toMatchObject({
      directManagerId: m.id,
    });
    expect((await world.record(futureRecordId, '2026-10-20')).fields).toMatchObject({ directManagerId: x.id });
  });
});

describe('AC-EMP-15 按记录在时间轴上的真实位置与有效区间判断（DEC-108，PR #54 P2-B）', () => {
  it('编辑被同日后继取代的 A（有效区间为空）改经理不误拒；当天生效的 B 改同一经理仍按其区间拒绝', async () => {
    const { world, x, m, a, b } = await sameDayChain('emp15sameday', 'x');
    const edited = await editManager(world, a, await businessRevision(world, a), m.id);
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await world.record(a, '2026-10-02')).fields).toMatchObject({ directManagerId: m.id });
    expect((await world.record(b, '2026-10-02')).fields).toMatchObject({ directManagerId: x.id });
    await expectCycle(
      await editManager(world, b, await businessRevision(world, b), m.id),
      '存在以下循环汇报，请修改。员工E 的直线经理汇报线循环：员工E→下属M→员工E（自 2026-10-03 起）',
    );
    expect((await world.record(b, '2026-10-03')).fields).toMatchObject({ directManagerId: x.id });
  });

  it('编辑 A 时实际被向后修改的同日后继 B 按 B 自己的有效区间逐条校验：成环只跳过 B 的该字段', async () => {
    const { world, m, a, b } = await sameDayChain('emp15samedayforward', 'none');
    const preview = await world.request('POST', `/records/${a}/forward-update-preview`, {
      body: { fields: { directManagerId: m.id } },
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(((await preview.json()) as { skipped: unknown[] }).skipped).toContainEqual({
      businessId: b,
      reason: 'REPORTING_CYCLE',
      fields: ['directManagerId'],
    });
    const edited = await editManager(world, a, await businessRevision(world, a), m.id);
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await world.record(a, '2026-10-02')).fields).toMatchObject({ directManagerId: m.id });
    expect((await world.record(b, '2026-10-02')).fields).toMatchObject({ directManagerId: null });
  });
});
