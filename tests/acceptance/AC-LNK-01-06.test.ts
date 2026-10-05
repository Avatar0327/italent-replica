/**
 * R1-T10 调动跨对象联动（REQ-LNK-001，`21` §4）：联动在生效时执行（R1），合同经 R2-T06 端口生成新版本（R2），
 * 职责转交允许部分失败、可单独重试（R3），薪资只生成“待调薪”提醒（R4，DEC-002）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { AppError } from '@italent/api';
import { registerTransferPartTimePort } from '../../apps/api/src/modules/transfer/linkage/part-time.js';
import { D, linkageWorld, type LinkageWorld } from './AC-LNK-support.js';

const database = useTestDb();

/** 兼职模块（R2-T05）未上线：用测试替身登记兼职记录与结束结果（同 DEC-145 编制判定替身的做法）。 */
const partTimes = new Map<string, { employeeId: string; endDate: string | null; fail: boolean }>();
registerTransferPartTimePort({
  async exists(_tx, _ctx, input) {
    return partTimes.get(input.recordId)?.employeeId === input.employeeId;
  },
  async end(_tx, _ctx, input) {
    const record = partTimes.get(input.recordId)!;
    if (record.fail) throw new AppError('CONFLICT', '兼职记录已变更', { reason: 'PART_TIME_CHANGED' });
    record.endDate = input.endDate;
  },
});

async function approved(w: LinkageWorld, person: { employee: { id: string } }, linkage: object) {
  const business = await w.saved(await w.transfer(person, { linkage }));
  expect(business.status).toBe('in_review');
  return w.approve(business, '2026-10-02T01:00:00Z');
}

describe('AC-LNK-01 / 02 合同变更在生效时经合同端口执行', () => {
  it('审批通过未到生效日合同不变；生效日生成新合同版本与变动记录，重复调度不重复变更', async () => {
    const w = await linkageWorld(database().db, 'lnk-contract');
    const person = await w.hire('变更合同员工');
    const original = await w.contract(person.employee.id);
    const business = await approved(w, person, {
      contract: { targetId: original.id, fields: { endDate: '2029-10-09' } },
    });
    expect(business.status).toBe('approved');
    // AC-LNK-01：审批通过 ≠ 生效，合同尚未变更。
    expect((await w.contracts(person.employee.id)).map((c) => [c.id, c.status])).toEqual([[original.id, 'valid']]);
    expect((await w.linkage(business.id)).executedAt).toBeNull();
    expect((await w.runScheduler('2026-10-09T01:00:00Z')).activated).toEqual([]);
    expect(await w.contracts(person.employee.id)).toHaveLength(1);

    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ activated: [business.id], failed: [], errors: [] });
    const [before, after] = await w.contracts(person.employee.id);
    expect(before).toMatchObject({ id: original.id, status: 'terminated', actualTerminationDate: '2026-10-09' });
    expect(after).toMatchObject({
      status: 'valid',
      effectiveDate: D,
      endDate: '2029-10-09',
      previousContractId: original.id,
    });
    // AC-LNK-02：合同变动记录指向变动前合同。
    expect(await w.contractChanges(person.employee.id)).toEqual([
      { beforeContractId: original.id, afterContractId: after!.id },
    ]);
    const view = await w.linkage(business.id);
    expect(view.executedAt).not.toBeNull();
    expect(view.contract).toEqual({ beforeContractId: original.id, afterContractId: after!.id });

    const events = await w.outboxEvents(business.id);
    await w.runScheduler('2026-10-10T02:00:00Z');
    expect(await w.contracts(person.employee.id)).toHaveLength(2);
    expect(await w.outboxEvents(business.id)).toEqual(events);
  });

  it('合同字段不能另设生效日；目标合同须属于该员工且有效', async () => {
    const w = await linkageWorld(database().db, 'lnk-contract-input');
    const person = await w.hire('合同入参员工');
    const other = await w.hire('他人');
    const own = await w.contract(person.employee.id);
    const foreign = await w.contract(other.employee.id);
    const dated = await w.transfer(person, {
      linkage: { contract: { targetId: own.id, fields: { effectiveDate: '2026-11-01' } } },
    });
    expect(dated.status).toBe(400);
    const wrong = await w.transfer(person, { linkage: { contract: { targetId: foreign.id } } });
    expect(wrong.status).toBe(404);
  });
});

describe('DEC-183 变更合同遇同类型在途未来合同', () => {
  it('保存、提交、修改联动时都 409；其他类型的在途合同不拦', async () => {
    const w = await linkageWorld(database().db, 'lnk-dec183-save');
    const person = await w.hire('在途合同员工');
    const current = await w.contract(person.employee.id);
    const draft = await w.saved(
      await w.transfer(person, { submit: false, linkage: { contract: { targetId: current.id } } }),
    );
    expect(draft.status).toBe('draft');
    // 已批准未生效的同类型新合同（未来生效）。
    await w.contract(person.employee.id, { effectiveDate: '2026-12-01', endDate: '2027-11-30', termMonths: 12 });
    const blocked = await w.transfer(person, { linkage: { contract: { targetId: current.id } } });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { reason: 'TRANSFER_CONTRACT_IN_FLIGHT' } },
    });
    const submit = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submit.status).toBe(409);
    expect(await submit.json()).toMatchObject({ error: { details: { reason: 'TRANSFER_CONTRACT_IN_FLIGHT' } } });
    const edit = await w.session.request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: { contract: { targetId: current.id, fields: { endDate: '2030-01-01' } } },
    });
    expect(edit.status).toBe(409);
    // 不勾选变更合同的联动修改不受在途合同影响。
    const withoutContract = await w.session.request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: { adjustSalary: true },
    });
    expect(withoutContract.status, await withoutContract.clone().text()).toBe(200);

    const another = await w.hire('其他类型在途');
    const own = await w.contract(another.employee.id);
    await w.contract(another.employee.id, {
      typeId: w.otherType.id,
      effectiveDate: '2026-12-01',
      endDate: '2027-11-30',
      termMonths: 12,
    });
    expect((await w.transfer(another, { linkage: { contract: { targetId: own.id } } })).status).toBe(201);
  });
});

describe('AC-LNK-03 / 04 职责转交', () => {
  async function dutyWorld(label: string, cyclic: boolean) {
    const w = await linkageWorld(database().db, label);
    const manager = await w.hire('部门负责人');
    await w.setHead(w.from, manager.employee.id);
    const subordinates = [
      await w.hire('下属一', { directManagerId: manager.employee.id }),
      await w.hire('下属二', { directManagerId: manager.employee.id }),
    ];
    // 失败场景：接收人汇报给下属二，转交后形成汇报线循环（`30` DT-R6）。
    const receiver = await w.hire('接收人', cyclic ? { directManagerId: subordinates[1]!.employee.id } : {});
    const business = await w.saved(
      await w.transfer(manager, {
        mode: 'direct',
        submit: false,
        linkage: {
          dutyTransfer: {
            subordinates: subordinates.map((s) => ({
              employeeId: s.employee.id,
              receiverId: receiver.employee.id,
              relation: 'direct',
            })),
            orgRoles: [{ orgId: w.from.id, role: 'person_in_charge', receiverId: receiver.employee.id }],
          },
        },
      }),
    );
    return { w, manager, subordinates, receiver, business };
  }

  it('AC-LNK-03 生效日生成组织角色转交 1 条、下属转交 N 条；生效前不转交', async () => {
    const { w, manager, subordinates, receiver, business } = await dutyWorld('lnk-duty', false);
    expect((await w.orgPeople(w.from.id)).head).toBe(manager.employee.id);
    expect(await w.managerOf(subordinates[0]!.hire.id)).toBe(manager.employee.id);
    expect((await w.linkage(business.id)).dutyTransfer).toBeNull();
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ failed: [], errors: [] });
    const view = await w.linkage(business.id);
    expect(view.dutyTransfer).toMatchObject({ total: 3, orgRoleCount: 1, subordinateCount: 2, failedCount: 0 });
    expect(view.dutyTransfer!.items.every((item) => item.status === 'succeeded')).toBe(true);
    expect((await w.orgPeople(w.from.id)).head).toBe(receiver.employee.id);
    for (const subordinate of subordinates) expect(await w.managerOf(subordinate.hire.id)).toBe(receiver.employee.id);
    // 原地改写下属当前任职，不新增任职记录（与新增下属同一口径，`08` 附表 W-013）。
    expect(await w.session.records(subordinates[0]!.employee.id)).toHaveLength(1);
  });

  it('AC-LNK-04 一个下属转交失败：调动照常生效，失败数 = 1，明细可查，修正后单独重试', async () => {
    const { w, manager, subordinates, receiver, business } = await dutyWorld('lnk-duty-fail', true);
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ failed: [], errors: [] });
    expect((await w.business(business.id)).activation).toMatchObject({ status: 'effective' });
    const view = await w.linkage(business.id);
    expect(view.dutyTransfer).toMatchObject({ total: 3, failedCount: 1 });
    const failed = view.dutyTransfer!.items.find((item) => item.status === 'failed')!;
    expect(failed).toMatchObject({ subordinateId: subordinates[1]!.employee.id, attemptCount: 1 });
    expect(failed.failure?.code).toBeTruthy();
    expect(await w.managerOf(subordinates[1]!.hire.id)).toBe(manager.employee.id);
    expect(await w.managerOf(subordinates[0]!.hire.id)).toBe(receiver.employee.id);
    expect((await w.linkageEvents(business.id)).map((e) => e.eventType)).toContain('transfer.linkage.item.failed');

    // 未修正就重试：仍失败，次数 + 1。
    const again = await w.retryItem(failed);
    expect(again.status, await again.clone().text()).toBe(200);
    const stillFailed = (await again.json()) as typeof failed;
    expect(stillFailed).toMatchObject({ status: 'failed', attemptCount: 2 });
    // 旧 revision 重试 409，不盲重试。
    expect((await w.retryItem(failed)).status).toBe(409);

    w.session.setNow('2026-10-10T03:00:00Z');
    const receiverRecord = await w.business(receiver.hire.id);
    const fixed = await w.session.request('PATCH', `/records/${receiver.hire.id}`, {
      ifMatch: receiverRecord.revision,
      body: { fields: { directManagerId: null } },
    });
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    const retried = await w.retryItem(stillFailed);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'succeeded', attemptCount: 3, failure: null });
    expect(await w.managerOf(subordinates[1]!.hire.id)).toBe(receiver.employee.id);
    expect((await w.linkage(business.id)).dutyTransfer).toMatchObject({ failedCount: 0 });
    // 已成功的子项不能再重试。
    const done = (await w.linkage(business.id)).dutyTransfer!.items.find((i) => i.id === failed.id)!;
    expect((await w.retryItem(done)).status).toBe(409);
  });

  it('下属须当前汇报给调动人；接收人不能是调动人本人或跨租户人员', async () => {
    const w = await linkageWorld(database().db, 'lnk-duty-input');
    const other = await linkageWorld(database().db, 'lnk-duty-input-other');
    const manager = await w.hire('调动人');
    const stranger = await w.hire('无汇报关系');
    const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
    const foreign = await other.hire('他租户');
    const cases = [
      { employeeId: stranger.employee.id, receiverId: subordinate.employee.id },
      { employeeId: subordinate.employee.id, receiverId: manager.employee.id },
      { employeeId: subordinate.employee.id, receiverId: foreign.employee.id },
    ];
    for (const item of cases) {
      const response = await w.transfer(manager, {
        linkage: { dutyTransfer: { subordinates: [{ ...item, relation: 'direct' }] } },
      });
      expect(response.status, JSON.stringify(item)).toBe(400);
    }
    const role = await w.transfer(manager, {
      linkage: {
        dutyTransfer: { orgRoles: [{ orgId: w.from.id, role: 'person_in_charge', receiverId: stranger.employee.id }] },
      },
    });
    expect(role.status).toBe(400);
    expect(await role.json()).toMatchObject({ error: { details: { reason: 'TRANSFER_ORG_ROLE_NOT_HELD' } } });
  });
});

describe('AC-LNK-05 调整薪资只生成待调薪提醒（DEC-002）', () => {
  it('勾选调整薪资：生效前无提醒；生效时生成一条待调薪提醒，不触碰薪资档案', async () => {
    const w = await linkageWorld(database().db, 'lnk-salary');
    const person = await w.hire('调薪员工');
    const business = await approved(w, person, { adjustSalary: true });
    expect((await w.linkage(business.id)).salaryReminder).toBeNull();
    await w.runScheduler('2026-10-10T01:00:00Z');
    expect((await w.linkage(business.id)).salaryReminder).toMatchObject({ status: 'pending' });
    const reminders = (await w.linkageEvents(business.id)).filter(
      (e) => e.eventType === 'transfer.linkage.salary_reminder',
    );
    expect(reminders).toHaveLength(1);
    await w.runScheduler('2026-10-10T05:00:00Z');
    expect(
      (await w.linkageEvents(business.id)).filter((e) => e.eventType === 'transfer.linkage.salary_reminder'),
    ).toHaveLength(1);
  });
});

describe('AC-LNK-06 结束兼职', () => {
  it('生效时兼职失效日期 = 调动生效日 − 1；兼职失败单独记录，修正后重试', async () => {
    const w = await linkageWorld(database().db, 'lnk-part-time');
    const person = await w.hire('兼职员工');
    const ok = crypto.randomUUID();
    const broken = crypto.randomUUID();
    partTimes.set(ok, { employeeId: person.employee.id, endDate: null, fail: false });
    partTimes.set(broken, { employeeId: person.employee.id, endDate: null, fail: true });
    const unknown = await w.transfer(person, { linkage: { partTimes: [{ recordId: crypto.randomUUID() }] } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_RECORD_NOT_FOUND' } } });
    const business = await approved(w, person, { partTimes: [{ recordId: ok }, { recordId: broken }] });
    await w.runScheduler('2026-10-09T01:00:00Z');
    expect(partTimes.get(ok)!.endDate).toBeNull();
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ activated: [business.id], failed: [], errors: [] });
    expect(partTimes.get(ok)!.endDate).toBe('2026-10-09');
    const view = await w.linkage(business.id);
    expect(view.partTimes.map((item) => [item.partTimeRecordId, item.status, item.effectiveDate])).toEqual(
      expect.arrayContaining([
        [ok, 'succeeded', '2026-10-09'],
        [broken, 'failed', '2026-10-09'],
      ]),
    );
    partTimes.get(broken)!.fail = false;
    const failed = view.partTimes.find((item) => item.status === 'failed')!;
    const retried = await w.retryItem(failed);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(partTimes.get(broken)!.endDate).toBe('2026-10-09');
  });
});

describe('试岗与调动交接（`21` §3.5：首版只做数据记录）', () => {
  it('生效时生成试岗期信息与交接记录；生效前没有', async () => {
    const w = await linkageWorld(database().db, 'lnk-trial');
    const person = await w.hire('试岗员工');
    const handover = await w.hire('交接人');
    const business = await approved(w, person, {
      onTrial: { months: 3 },
      handover: { handoverPersonId: handover.employee.id },
    });
    const pending = await w.linkage(business.id);
    expect(pending.onTrial).toBeNull();
    expect(pending.handover).toBeNull();
    expect(pending.options).toMatchObject({ onTrial: { months: 3 } });
    await w.runScheduler('2026-10-10T01:00:00Z');
    const view = await w.linkage(business.id);
    expect(view.onTrial).toEqual({ startDate: D, months: 3, expectedEndDate: '2027-01-09', status: 'in_trial' });
    expect(view.handover).toEqual({
      handoverPersonId: handover.employee.id,
      handoverStatus: 'not_started',
      approvalStatus: null,
    });
  });
});

describe('联动选项的修改边界与租户隔离', () => {
  it('草稿可改联动（revision 递增）；审批中、已生效不可改；他租户读不到', async () => {
    const w = await linkageWorld(database().db, 'lnk-edit');
    const other = await linkageWorld(database().db, 'lnk-edit-other');
    const person = await w.hire('改联动员工');
    const draft = await w.saved(await w.transfer(person, { submit: false, linkage: { adjustSalary: true } }));
    const edited = await w.session.request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: { adjustSalary: false, onTrial: { months: 6, startDate: '2026-10-15' } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const after = (await edited.json()) as { revision: number };
    expect(after.revision).toBeGreaterThan(draft.revision);
    expect((await w.linkage(draft.id)).options).toMatchObject({
      adjustSalary: false,
      onTrial: { months: 6, startDate: '2026-10-15' },
    });
    const stale = await w.session.request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: { adjustSalary: true },
    });
    expect(stale.status).toBe(409);
    const submitted = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: after.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const { revision } = (await submitted.json()) as { revision: number };
    const inReview = await w.session.request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: revision,
      body: { adjustSalary: true },
    });
    expect(inReview.status).toBe(409);
    const foreign = await other.session.request('GET', `/transfers/${draft.id}/linkage`);
    expect(foreign.status).toBe(404);
  });
});
