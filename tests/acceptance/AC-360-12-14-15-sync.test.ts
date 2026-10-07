/**
 * 360 人员与组织员工同步（DEC-030）：AC-360-12 邮箱变更后再同步不产生重复人员；AC-360-14 同步以组织为准、邮箱锁定；
 * AC-360-15 首次同步查重冲突由管理员确认并写关联日志；批量导入评价者可选“不同步”。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import { type PersonView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();

interface SyncResult {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
}

async function hired(w: World360, name: string) {
  const org = await w.session.org(`${name}部门`, { establishedOn: '2025-01-01' });
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
    employee.revision,
  );
  return { employee, org };
}

const sync = (w: World360) => w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
const people = async (w: World360) =>
  (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;

describe('AC-360-12 员工邮箱变更后再同步', () => {
  it('更新同一个 360 人员，不产生重复人员；活动历史仍归属该人', async () => {
    const w = await world360(testDb().db, 'y12');
    const { employee } = await hired(w, '同步员工');
    const first = await sync(w);
    expect(first.created).toHaveLength(1);
    const personId = first.created[0]!.personId;
    const person = await w.ok<PersonView>(w.request('GET', `/people/${personId}`));
    expect(person).toMatchObject({ email: loginEmailOf(employee.id), employeeId: employee.id, emailLocked: true });
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity();
    const object = await w.object(activity.id, personId, [q.id]);

    const patched = await w.session.request('GET', `/employees/${employee.id}`);
    expect(patched.status).toBe(200);
    const update = await w.api.request('PATCH', `/api/tenant/personnel/employees/${employee.id}`, {
      user: w.admin,
      tenant: w.tenantId,
      ifMatch: 0,
      body: { workEmail: 'changed-y12@example.com' },
    });
    expect(update.status, await update.clone().text()).toBe(200);
    const second = await sync(w);
    expect(second.created).toEqual([]);
    expect(second.updated.map((u) => u.personId)).toEqual([personId]);
    const all = await people(w);
    expect(all.filter((p) => p.employeeId === employee.id)).toHaveLength(1);
    expect(all.find((p) => p.id === personId)!.email).toBe('changed-y12@example.com');
    const objects = await w.ok<{ items: { id: string; personId: string }[] }>(
      w.request('GET', `/activities/${activity.id}/objects`),
    );
    expect(objects.items).toEqual([expect.objectContaining({ id: object.id, personId })]);
  });
});

describe('AC-360-14 同步以组织为准、邮箱锁定', () => {
  it('360 端改过部门后再同步被组织值覆盖；邮箱不可在 360 端编辑（409）', async () => {
    const w = await world360(testDb().db, 'y14');
    const { org } = await hired(w, '部门员工');
    const personId = (await sync(w)).created[0]!.personId;
    const person = await w.ok<PersonView>(w.request('GET', `/people/${personId}`));
    expect(person.department).toBe(org.name);
    const edited = await w.ok<PersonView>(
      w.request('PUT', `/people/${personId}`, { ifMatch: person.revision, body: { department: '360自改部门' } }),
    );
    expect(edited.department).toBe('360自改部门');
    const locked = await w.request('PUT', `/people/${personId}`, {
      ifMatch: edited.revision,
      body: { email: 'other-y14@example.com' },
    });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'EMAIL_LOCKED',
    );
    expect(await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).toEqual(edited);
    await sync(w);
    expect((await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).department).toBe(org.name);
  });

  it('未同步的外部人员邮箱可改；邮箱按不区分大小写唯一', async () => {
    const w = await world360(testDb().db, 'y14b');
    const a = await w.person('外部甲');
    const b = await w.person('外部乙');
    const dup = await w.request('PUT', `/people/${b.id}`, {
      ifMatch: b.revision,
      body: { email: a.email.toUpperCase() },
    });
    expect(dup.status).toBe(409);
    const changed = await w.ok<PersonView>(
      w.request('PUT', `/people/${a.id}`, { ifMatch: a.revision, body: { email: 'new-y14b@example.com' } }),
    );
    expect(changed.email).toBe('new-y14b@example.com');
  });
});

describe('AC-360-15 首次同步查重冲突', () => {
  it('邮箱与已有外部人员相同：不自动合并，列入冲突；确认后挂接并写关联日志', async () => {
    const w = await world360(testDb().db, 'y15');
    const { employee } = await hired(w, '冲突员工');
    const external = await w.ok<PersonView>(
      w.request('POST', '/people', { ifMatch: 0, body: { name: '外部同邮箱', email: loginEmailOf(employee.id) } }),
      201,
    );
    const result = await sync(w);
    expect(result.created).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect((await w.ok<PersonView>(w.request('GET', `/people/${external.id}`))).employeeId).toBeNull();
    expect((await people(w)).filter((p) => p.email.toLowerCase() === external.email.toLowerCase())).toHaveLength(1);
    // 冲突未处理前再次同步不重复登记
    expect((await sync(w)).conflicts).toEqual(result.conflicts);
    const conflicts = await w.ok<{
      items: {
        id: string;
        employeeId: string;
        matchedBy: string[];
        candidates: { personId: string }[];
        revision: number;
      }[];
    }>(w.request('GET', '/people/sync-conflicts'));
    expect(conflicts.items).toHaveLength(1);
    const conflict = conflicts.items[0]!;
    expect(conflict).toMatchObject({ employeeId: employee.id, matchedBy: ['email'] });
    expect(conflict.candidates.map((c) => c.personId)).toEqual([external.id]);
    const resolved = await w.ok<{ status: string; resolvedPersonId: string }>(
      w.request('POST', `/people/sync-conflicts/${conflict.id}/resolve`, {
        ifMatch: conflict.revision,
        body: { action: 'link', personId: external.id },
      }),
    );
    expect(resolved).toMatchObject({ status: 'resolved', resolvedPersonId: external.id });
    const linked = await w.ok<PersonView>(w.request('GET', `/people/${external.id}`));
    expect(linked).toMatchObject({ employeeId: employee.id, emailLocked: true });
    const logs = await w.ok<{ items: { reason: string; employeeId: string; matchedBy: string[] }[] }>(
      w.request('GET', `/people/${external.id}/link-logs`),
    );
    expect(logs.items).toEqual([expect.objectContaining({ reason: 'admin_confirm', employeeId: employee.id })]);
    // 已处理的冲突不能再处理
    const again = await w.request('POST', `/people/sync-conflicts/${conflict.id}/resolve`, {
      ifMatch: conflict.revision + 1,
      body: { action: 'ignore' },
    });
    expect(again.status).toBe(409);
  });

  it('工号命中：可确认为新建独立人员；忽略后不再列出', async () => {
    const w = await world360(testDb().db, 'y15b');
    const { employee } = await hired(w, '工号员工');
    const same = await w.person('同工号外部', { staffCode: employee.code });
    const { conflicts } = await sync(w);
    expect(conflicts).toHaveLength(1);
    const [conflict] = (
      await w.ok<{ items: { id: string; matchedBy: string[]; revision: number }[] }>(
        w.request('GET', '/people/sync-conflicts'),
      )
    ).items;
    expect(conflict!.matchedBy).toEqual(['staff_code']);
    const created = await w.ok<{ status: string; resolvedPersonId: string }>(
      w.request('POST', `/people/sync-conflicts/${conflict!.id}/resolve`, {
        ifMatch: conflict!.revision,
        body: { action: 'create' },
      }),
    );
    expect(created.resolvedPersonId).not.toBe(same.id);
    expect((await w.ok<{ items: unknown[] }>(w.request('GET', '/people/sync-conflicts'))).items).toEqual([]);
  });

  it('只有 360 系统管理员可以同步与处理冲突', async () => {
    const w = await world360(testDb().db, 'y15c');
    await hired(w, '员工');
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const res = await w.as(general)('POST', '/people/sync', { body: {} });
    expect(res.status).toBe(403);
    expect(await people(w)).toEqual([]);
  });
});

describe('批量导入评价者可选“不同步”（DEC-030 ④）', () => {
  it('同步：已挂接人员以组织信息为准；不同步：以上传信息为准', async () => {
    const w = await world360(testDb().db, 'y16');
    const { employee, org } = await hired(w, '导入员工');
    const personId = (await sync(w)).created[0]!.personId;
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, peer: 1 }));
    const activity = await w.activity();
    const target = await w.person('导入对象');
    await w.object(activity.id, target.id, [q.id]);
    const row = {
      objectEmail: target.email,
      roleId: w.role('peer'),
      name: '上传姓名',
      email: loginEmailOf(employee.id),
      department: '上传部门',
    };
    const synced = await w.request('POST', `/activities/${activity.id}/appraisers/import`, {
      ifMatch: 0,
      body: { sync: true, rows: [row] },
    });
    expect(synced.status, await synced.clone().text()).toBe(200);
    expect(await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).toMatchObject({
      department: org.name,
      name: '导入员工',
    });
    const other = await w.person('另一对象');
    await w.object(activity.id, other.id, [q.id]);
    const unsynced = await w.request('POST', `/activities/${activity.id}/appraisers/import`, {
      ifMatch: 0,
      body: { sync: false, rows: [{ ...row, objectEmail: other.email }] },
    });
    expect(unsynced.status, await unsynced.clone().text()).toBe(200);
    expect(await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).toMatchObject({
      department: '上传部门',
      name: '上传姓名',
      email: loginEmailOf(employee.id),
    });
  });

  it('导入整批校验：任一行评价对象不存在则整体失败，数据不变', async () => {
    const w = await world360(testDb().db, 'y16b');
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, peer: 1 }));
    const activity = await w.activity();
    const target = await w.person('对象');
    const object = await w.object(activity.id, target.id, [q.id]);
    const res = await w.request('POST', `/activities/${activity.id}/appraisers/import`, {
      ifMatch: 0,
      body: {
        sync: false,
        rows: [
          { objectEmail: target.email, roleId: w.role('peer'), name: '甲', email: 'a-y16b@example.com' },
          { objectEmail: 'missing-y16b@example.com', roleId: w.role('peer'), name: '乙', email: 'b-y16b@example.com' },
        ],
      },
    });
    expect(res.status).toBe(400);
    const list = await w.ok<{ items: unknown[] }>(
      w.request('GET', `/activities/${activity.id}/objects/${object.id}/appraisers`),
    );
    expect(list.items).toEqual([]);
    expect((await people(w)).map((p) => p.email)).not.toContain('a-y16b@example.com');
  });
});
