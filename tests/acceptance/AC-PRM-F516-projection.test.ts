import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProfile, grant, makeGrantable } from './AC-PRM-support.js';
import { uniqueSuffix } from './support/unique.js';
import { f516World } from './AC-PRM-F516-support.js';

const database = useTestDb();
describe('AC-PRM-F516 人员手机号与员工概要状态', () => {
  let w: Awaited<ReturnType<typeof f516World>>;
  let person: Awaited<ReturnType<typeof w.person>>;
  beforeAll(async () => {
    w = await f516World(database().db);
    person = await w.person('合成投影员工', '13000000001', 'Zhang.San@example.com');
    const profile = await createProfile(w, `F516_${uniqueSuffix()}`);
    await makeGrantable(w, [profile.id]);
    expect((await grant(w, person.userId, profile.id)).status).toBe(201);
  });
  it('无当前任职显示待入职，两个列表读取档案手机号，无档案为空', async () => {
    const users = await w.page('/users');
    expect(users.items.find((row) => row.userId === person.userId)).toMatchObject({
      contactPhone: '13000000001',
      employeeStatus: 'pending',
      contactEmail: 'Zhang.San@example.com',
    });
    expect(users.items.find((row) => row.userId === w.admin.id)).toMatchObject({
      contactPhone: null,
      employeeStatus: null,
    });
    expect(users.unrecorded).toEqual(['loginPhone', 'source', 'createdBy']);
    expect((await w.page(`/grants?userId=${person.userId}`)).items[0]).toMatchObject({ phone: '13000000001' });
    expect(users.items[0]).not.toHaveProperty('loginPhone');
  });
  it('入职后使用复刻员工概要状态，与成员状态分开', async () => {
    const department = await w.hr.org('合成部门');
    const hired = await w.hr.hire(person, department);
    expect(hired.status, await hired.clone().text()).toBe(201);
    expect((await w.page('/users')).items.find((row) => row.userId === person.userId)).toMatchObject({
      employeeStatus: 'employed',
      membershipStatus: 'active',
    });
  });
  it('人员范围外、字段无权、对象无权均不披露新增值', async () => {
    for (const reader of [w.restricted([]), w.restricted(undefined, [], false)]) {
      const row = (await w.page('/users', reader)).items.find((item) => item.userId === person.userId)!;
      expect(row.contactPhone ?? null).toBeNull();
      expect(row.employeeStatus ?? null).toBeNull();
      const grants = await w.page(`/grants?userId=${person.userId}`, reader);
      expect(grants.items[0]!.phone ?? null).toBeNull();
    }
    const hidden = w.restricted(undefined, ['mobilePhone', 'employeeStatus']);
    const row = (await w.page('/users', hidden)).items.find((item) => item.userId === person.userId)!;
    expect(row).not.toHaveProperty('contactPhone');
    expect(row).not.toHaveProperty('employeeStatus');
    expect((await w.page(`/grants?userId=${person.userId}`, hidden)).items[0]).not.toHaveProperty('phone');
  });
});
