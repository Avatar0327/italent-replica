/** F-092（DEC-416⑦、Q-M0-172）：离职生效自动退组、撤销不恢复、仅在职候选。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { exitWorld, rowsOf } from './AC-EV-F092-support.js';
import { reviewOperator } from './AC-EV-review-support.js';
import { errorOf, EV_BASE, ok } from './AC-EV-support.js';
import type * as EmploymentStore from '../../apps/api/src/modules/employment/record-store.js';
import { uniqueSuffix } from './support/unique.js';

const fault = vi.hoisted(() => ({ beforeLock: false }));
vi.mock('../../apps/api/src/modules/employment/record-store.js', async (load) => {
  const original = await load<typeof EmploymentStore>();
  return {
    ...original,
    lockEmploymentEmployee: async (...args: Parameters<typeof original.lockEmploymentEmployee>) => {
      if (fault.beforeLock && args[1].commandId.startsWith('review-group-exit:')) {
        throw Object.assign(new Error('合成连接中断'), { code: 'ECONNRESET' });
      }
      return original.lockEmploymentEmployee(...args);
    },
  };
});

const database = useTestDb();

describe('AC-EV-F092 离职生效自动退出评审组', () => {
  it.each([
    { label: '生效日前一天', lastWorkDate: '2026-10-11', removed: false },
    { label: '生效日当天零点', lastWorkDate: '2026-10-10', removed: true },
    { label: '生效日之后', lastWorkDate: '2026-10-09', removed: true },
  ])('AC-EV-F092 $label：启用与停用组都按生效日处理，保留其他成员并写审计', async ({ lastWorkDate, removed }) => {
    const w = await exitWorld(database().db);
    const leaving = await w.hire('离职组长', w.orgA);
    const kept = await w.hire('留任评委', w.orgB);
    const groups = [await w.createGroup([leaving, kept]), await w.createGroup([leaving], false, w.orgB)];
    const commandId = randomUUID();
    await w.savedLeave(leaving, lastWorkDate, commandId);
    for (const [index, original] of groups.entries()) {
      let expectedMembers = index === 0 ? [leaving, kept] : [leaving];
      if (removed) expectedMembers = index === 0 ? [kept] : [];
      await w.expectMembers(original.id, expectedMembers);
      expect((await w.group(original.id)).revision).toBe(original.revision + Number(removed));
      const audits = await w.audits(original.id);
      expect(audits).toHaveLength(Number(removed));
      if (removed) {
        expect(audits[0]).toMatchObject({ commandId, actorUserId: w.admin.id });
        expect(audits[0]!.before.members[0]).toMatchObject({
          employeeId: leaving.id,
          employeeName: leaving.name,
          isLeader: true,
        });
        expect(audits[0]!.after.members.every((m) => m.employeeId !== leaving.id)).toBe(true);
        expect(audits[0]!.changes.some((change) => change.field === 'members')).toBe(true);
      }
    }
  });

  it('AC-EV-F092 撤销已生效离职只恢复在职状态与候选，不恢复任何组；重放不重复写审计', async () => {
    const w = await exitWorld(database().db);
    const leaving = await w.hire('撤销离职评委', w.orgA);
    const g = await w.createGroup([leaving]);
    const key = randomUUID();
    const current = await w.employee(leaving.id);
    const record = await w.savedLeave(leaving, '2026-10-10', key);
    await w.expectMembers(g.id, []);
    const replay = await w.request('POST', `/api/tenant/employment/employees/${leaving.id}/businesses`, {
      ifMatch: current.revision,
      idempotencyKey: key,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-10', fields: {} },
    });
    expect(replay.status).toBe(201);
    expect(await w.audits(g.id)).toHaveLength(1);
    expect((await w.candidates()).items.map((p) => p.id)).not.toContain(leaving.id);
    expect((await w.undo(record.id, record.revision)).status).toBe(200);
    expect((await w.employee(leaving.id)).status).toBe('employed');
    expect((await w.candidates()).items.map((p) => p.id)).toContain(leaving.id);
    await w.expectMembers(g.id, []);
    expect(await w.run()).toMatchObject({ picked: 0 });
    expect(await w.audits(g.id)).toHaveLength(1);
  });

  it('AC-EV-F092 未来直接离职：当地午夜前保留、当天到期退组，重复消费与次日消费不重复审计', async () => {
    const w = await exitWorld(database().db);
    w.setTime('2026-10-10T15:59:59Z');
    const leaving = await w.hire('午夜离职评委', w.orgA);
    const g = await w.createGroup([leaving], false);
    const record = await w.savedLeave(leaving, '2026-10-10');
    await w.expectMembers(g.id, [leaving]);
    expect((await w.candidates()).items.map((p) => p.id)).toContain(leaving.id);
    expect(await w.queue(record.id)).toMatchObject([{ state: 'pending', attempts: 0 }]);
    expect(await w.run()).toMatchObject({ picked: 0 });
    w.setTime('2026-10-10T16:00:00Z');
    expect(await w.run()).toMatchObject({ done: 1 });
    await w.expectMembers(g.id, []);
    expect(await w.queue(record.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
    expect((await w.candidates()).items.map((p) => p.id)).not.toContain(leaving.id);
    expect((await w.audits(g.id))[0]!.actorUserId).toBeNull();
    expect(await w.run()).toMatchObject({ picked: 0 });
    w.setTime('2026-10-11T16:00:00Z');
    expect(await w.run()).toMatchObject({ picked: 0 });
    expect(await w.audits(g.id)).toHaveLength(1);
  });

  it('AC-EV-F092 生效前删除未来离职：到期复核作废记录，不退出原有组', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('未来离职撤销评委', w.orgA);
    const g = await w.createGroup([person]);
    const record = await w.savedLeave(person, '2026-10-11');
    expect((await w.undo(record.id, record.revision)).status).toBe(200);
    w.setTime('2026-10-11T16:00:00Z');
    expect(await w.run()).toMatchObject({ skipped: 1 });
    expect(await w.queue(record.id)).toMatchObject([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    await w.expectMembers(g.id, [person]);
    expect(await w.audits(g.id)).toHaveLength(0);
  });

  it('AC-EV-F092 到期退组存储失败：整笔回滚，队列记 failed / 次数，退避到期重试成功', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('到期重试评委', w.orgA);
    const g = await w.createGroup([person]);
    const record = await w.savedLeave(person, '2026-10-11');
    w.setTime('2026-10-11T16:00:00Z');
    await w.db.execute(sql`CREATE FUNCTION f092_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='evaluation.review-group.update' THEN
        RAISE EXCEPTION USING ERRCODE='53100', MESSAGE='模拟审计存储失败'; END IF; RETURN NEW; END $$`);
    await w.db.execute(sql`CREATE TRIGGER f092_retry_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION f092_retry_audit()`);
    try {
      expect(await w.run()).toMatchObject({ failed: 1 });
    } finally {
      await w.db.execute(sql`DROP TRIGGER f092_retry_audit ON audit_events`);
      await w.db.execute(sql`DROP FUNCTION f092_retry_audit()`);
    }
    expect(await w.group(g.id)).toEqual(g);
    expect(await w.audits(g.id)).toHaveLength(0);
    expect(await w.queue(record.id)).toMatchObject([{ state: 'failed', attempts: 1, reason: '53100' }]);
    expect(await w.run()).toMatchObject({ picked: 0 });
    w.setTime('2026-10-11T16:01:00Z');
    // 下一次重试在拿到队列行之前连接中断，也必须按当前持久次数累加，不能当成第一次失败。
    fault.beforeLock = true;
    try {
      expect(await w.run()).toMatchObject({ failed: 1 });
    } finally {
      fault.beforeLock = false;
    }
    expect(await w.queue(record.id)).toMatchObject([{ state: 'failed', attempts: 2, reason: 'ECONNRESET' }]);
    w.setTime('2026-10-11T16:03:00Z');
    expect(await w.run()).toMatchObject({ done: 1 });
    await w.expectMembers(g.id, []);
    expect(await w.queue(record.id)).toMatchObject([{ state: 'done', attempts: 3 }]);
    expect(await w.audits(g.id)).toHaveLength(1);
  });

  it('AC-EV-F092 P2-1 到期未消费就撤销离职：全部组退出并审计，撤销后重新入组不被旧任务删除', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('到期撤销评委', w.orgA);
    const kept = await w.hire('撤销留任评委', w.orgB);
    const groups = [await w.createGroup([person, kept]), await w.createGroup([person], false, w.orgB)];
    const record = await w.savedLeave(person, '2026-10-11');
    w.setTime('2026-10-11T16:00:00Z');
    expect((await w.employee(person.id)).status).toBe('left');
    expect((await w.undo(record.id, record.revision)).status).toBe(200);
    expect((await w.employee(person.id)).status).toBe('employed');
    for (const [index, g] of groups.entries()) {
      await w.expectMembers(g.id, index ? [] : [kept]);
      expect((await w.group(g.id)).revision).toBe(g.revision + 1);
      expect(await w.audits(g.id)).toMatchObject([
        { actorUserId: w.admin.id, after: { members: index ? [] : [{ employeeId: kept.id, isLeader: false }] } },
      ]);
    }
    expect(await w.queue(record.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
    const fresh = await w.createGroup([person]);
    expect(await w.run()).toMatchObject({ picked: 0 });
    await w.expectMembers(fresh.id, [person]);
    for (const g of groups) expect(await w.audits(g.id)).toHaveLength(1);
  });

  it('AC-EV-F092 P2-1 删除重聘恢复离职：旧退出已完成也移出全部新组，保留其他成员及审计', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('删除重聘评委', w.orgA);
    const kept = await w.hire('删除重聘留任评委', w.orgB);
    const old = await w.createGroup([person]);
    const leave = await w.savedLeave(person, '2026-10-10');
    const rehire = await w.rehire(person, '2026-10-11');
    const groups = [await w.createGroup([person, kept]), await w.createGroup([person], false, w.orgB)];
    expect((await w.undo(rehire.id, rehire.revision)).status).toBe(200);
    expect((await w.employee(person.id)).status).toBe('left');
    for (const [index, g] of groups.entries()) {
      await w.expectMembers(g.id, index ? [] : [kept]);
      expect((await w.group(g.id)).revision).toBe(g.revision + 1);
      expect(await w.audits(g.id)).toHaveLength(1);
      expect((await w.audits(g.id))[0]!.actorUserId).toBe(w.admin.id);
    }
    await w.expectMembers(old.id, []);
    expect(await w.audits(old.id)).toHaveLength(1);
    expect(await w.queue(leave.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
    expect(await w.run()).toMatchObject({ picked: 0 });
  });

  it.each([
    { mode: '新建', failed: false },
    { mode: '编辑新增', failed: false },
    { mode: '新建', failed: true },
    { mode: '编辑新增', failed: true },
  ])(
    'AC-EV-F092 P2-2 $mode：结清旧退出（失败退避=$failed），旧组退出且重聘后新增成员不被迟到任务删除',
    async ({ mode, failed }) => {
      const w = await exitWorld(database().db);
      const person = await w.hire('迟到退出重聘评委', w.orgA);
      const kept = await w.hire('迟到退出留任评委', w.orgB);
      const old = await w.createGroup([person, kept]);
      const target = mode === '编辑新增' ? await w.createGroup([kept]) : undefined;
      const leave = await w.savedLeave(person, '2026-10-11');
      w.setTime('2026-10-12T16:00:00Z');
      if (failed) {
        await w.db.execute(sql`CREATE FUNCTION f092_late_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='evaluation.review-group.update' THEN
          RAISE EXCEPTION USING ERRCODE='53100', MESSAGE='模拟审计存储失败'; END IF; RETURN NEW; END $$`);
        await w.db.execute(sql`CREATE TRIGGER f092_late_audit BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION f092_late_audit()`);
        try {
          expect(await w.run()).toMatchObject({ failed: 1 });
        } finally {
          await w.db.execute(sql`DROP TRIGGER f092_late_audit ON audit_events`);
          await w.db.execute(sql`DROP FUNCTION f092_late_audit()`);
        }
      }
      await w.rehire(person, '2026-10-13');
      expect((await w.employee(person.id)).status).toBe('employed');
      const fresh = target
        ? await ok<{ id: string; revision: number }>(await w.edit(target, { members: w.members(person, kept) }))
        : await w.createGroup([person, kept]);
      // 先核对迟到任务不会伤害新周期成员，再核对旧组没有被“当前在职”短路而漏退。
      w.setTime('2026-10-12T16:01:00Z');
      await w.run();
      await w.expectMembers(fresh.id, [person, kept]);
      expect((await w.group(fresh.id)).revision).toBe(fresh.revision);
      expect(await w.audits(fresh.id)).toHaveLength(target ? 1 : 0);
      await w.expectMembers(old.id, [kept]);
      expect((await w.group(old.id)).revision).toBe(old.revision + 1);
      expect(await w.audits(old.id)).toHaveLength(1);
      expect(await w.queue(leave.id)).toMatchObject([{ state: 'done', attempts: failed ? 2 : 1 }]);
      expect(await w.run()).toMatchObject({ picked: 0 });
    },
  );

  it('AC-EV-F092 候选只列当前在职；未任职、未来入职、退休与离职不占分页；范围外仍不可见', async () => {
    const w = await exitWorld(database().db);
    const active = await w.hire('候选在职评委', w.orgA);
    const outside = await w.hire('候选范围外评委', w.orgB);
    const left = await w.hire('候选离职评委', w.orgA);
    const retired = await w.hire('候选退休评委', w.orgA);
    await w.savedLeave(left, '2026-10-10');
    const current = await w.employee(retired.id);
    await ok(
      await w.request('POST', `/api/tenant/employment/employees/${retired.id}/businesses`, {
        ifMatch: current.revision,
        body: { kind: 'retirement', mode: 'direct', lastWorkDate: '2026-10-10', fields: {} },
      }),
      201,
    );
    await ok<{ id: string; revision: number }>(
      await w.request('POST', '/api/tenant/employment/employees', {
        ifMatch: 0,
        body: { name: '候选尚未任职', code: `P${uniqueSuffix()}` },
      }),
      201,
    );
    const future = await ok<{ id: string; revision: number }>(
      await w.request('POST', '/api/tenant/employment/employees', {
        ifMatch: 0,
        body: { name: '候选未来入职', code: `F${uniqueSuffix()}` },
      }),
      201,
    );
    await ok(
      await w.request('POST', `/api/tenant/employment/employees/${future.id}/businesses`, {
        ifMatch: future.revision,
        body: {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-11-01',
          fields: { departmentId: w.orgA },
          loginEmail: `${future.id}@example.com`,
        },
      }),
      201,
    );
    const candidates = (await w.candidates()).items;
    expect(candidates.map((p) => p.id).sort()).toEqual([active.id, outside.id].sort());
    expect(candidates.find((p) => p.id === active.id)).toMatchObject({ name: active.name, code: active.code });
    const manager = await reviewOperator(w.review, { evOrgs: [w.orgA], personOrgs: [w.orgA] });
    const visible = await ok<{ items: { id: string }[] }>(
      await manager.request('GET', '/candidates/review-members?pageSize=1'),
    );
    expect(visible.items.map((p) => p.id)).toEqual([active.id]);
    for (const keyword of [left.code, retired.code, '尚未任职', '未来入职', outside.code]) {
      expect(
        (await ok<{ items: unknown[] }>(await manager.request('GET', `/candidates/review-members?keyword=${keyword}`)))
          .items,
      ).toEqual([]);
    }
  });

  it('AC-EV-F092 新建与编辑拒绝新增已离职成员，旧 revision 不会静默加回；数据不变', async () => {
    const w = await exitWorld(database().db);
    const leaving = await w.hire('拒绝回填评委', w.orgA);
    const kept = await w.hire('拒绝回填留任评委', w.orgA);
    const original = await w.createGroup([leaving, kept]);
    await w.savedLeave(leaving, '2026-10-10');
    const fresh = await w.group(original.id);
    const stale = await w.edit(original, { members: w.members(leaving, kept) });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
    const added = await w.edit(fresh, { members: w.members(leaving, kept) });
    expect(added.status).toBe(400);
    expect((await errorOf(added)).reason).toBe('REVIEW_GROUP_MEMBER_NOT_EMPLOYED');
    const created = await w.request('POST', `${EV_BASE}/review-groups`, {
      ifMatch: 0,
      body: { name: '不能重新入组', ownerOrgId: w.orgA, members: w.members(leaving) },
    });
    expect(created.status).toBe(400);
    expect((await errorOf(created)).reason).toBe('REVIEW_GROUP_MEMBER_NOT_EMPLOYED');
    expect(await w.group(original.id)).toEqual(fresh);
    expect(await w.audits(original.id)).toHaveLength(1);
  });

  it('AC-EV-F092 第二个组写审计失败：离职、全部组、revision、审计与队列整体回滚', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('事务回滚评委', w.orgA);
    const groups = [await w.createGroup([person]), await w.createGroup([person], false)];
    await w.db.execute(sql`CREATE FUNCTION f092_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='evaluation.review-group.update' AND EXISTS (SELECT 1 FROM audit_events
        WHERE action=NEW.action AND command_id=NEW.command_id) THEN
        RAISE EXCEPTION USING ERRCODE='53100', MESSAGE='模拟审计存储失败'; END IF; RETURN NEW; END $$`);
    await w.db.execute(sql`CREATE TRIGGER f092_reject_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION f092_reject_audit()`);
    try {
      expect((await w.leave(person, '2026-10-10')).status).toBe(503);
    } finally {
      await w.db.execute(sql`DROP TRIGGER f092_reject_audit ON audit_events`);
      await w.db.execute(sql`DROP FUNCTION f092_reject_audit()`);
    }
    expect((await w.employee(person.id)).status).toBe('employed');
    for (const g of groups) {
      expect(await w.group(g.id)).toEqual(g);
      expect(await w.audits(g.id)).toHaveLength(0);
    }
    const records = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT id FROM employment_records WHERE tenant_id=${w.tenant.id} AND employee_id=${person.id} AND kind='leave'`),
      ),
    );
    expect(records).toHaveLength(0);
  });
});
