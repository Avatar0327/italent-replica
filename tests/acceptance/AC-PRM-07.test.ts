/**
 * AC-PRM-07（REQ-PRM-001 R3；DEC-042）：用户持有多个身份 → 权限取并集。
 * 本任务（R1-T01）覆盖功能权限的并集：字段、按钮、数据操作“任一身份允许即允许”，不做拒绝优先。
 * 数据范围的并集属于 R1-T02（AC-PRM-07 的范围部分在 T02 补测）。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  myObject,
  type MyObjectPermission,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';

const testDb = useTestDb();

describe('AC-PRM-07 多身份功能权限取并集（DEC-042）', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('身份 P1 只看姓名、能编辑；P2 只看手机、能删除、能打印 → 同时持有两者得到并集', async () => {
    const p1 = await createProfile(world, 'p1');
    const p2 = await createProfile(world, 'p2');
    await setObjectPermission(world, p1, {
      dataOperations: { create: false, update: true, delete: false },
      fields: [
        { fieldCode: 'Name', view: true, edit: true },
        { fieldCode: 'MobilePhone', view: false, edit: false },
      ],
      buttons: [{ buttonCode: 'EmploymentRecord.Edit', level: 'detail' }],
    });
    await setObjectPermission(world, p2, {
      dataOperations: { create: false, update: false, delete: true },
      fields: [{ fieldCode: 'MobilePhone', view: true, edit: false }],
      buttons: [
        { buttonCode: 'EmploymentRecord.Delete', level: 'detail' },
        { buttonCode: 'EmploymentRecord.Print', level: 'detail' },
      ],
    });
    await makeGrantable(world, [p1.id, p2.id]);

    const user = await addMember(world, 'multi');
    expect((await grant(world, user.id, p1.id)).status).toBe(201);
    const onlyP1 = (await (await myObject(world, user)).json()) as MyObjectPermission;
    expect(onlyP1.viewableFields).toEqual(['Name']);
    expect(onlyP1.dataOperations).toEqual({ create: false, update: true, delete: false });

    expect((await grant(world, user.id, p2.id)).status).toBe(201);
    const both = (await (await myObject(world, user)).json()) as MyObjectPermission;
    expect(both.viewableFields.sort()).toEqual(['MobilePhone', 'Name']);
    expect(both.editableFields).toEqual(['Name']);
    expect(both.dataOperations).toEqual({ create: false, update: true, delete: true });
    expect(both.buttons.map((b) => b.buttonCode).sort()).toEqual([
      'EmploymentRecord.Delete',
      'EmploymentRecord.Edit',
      'EmploymentRecord.Print',
    ]);
  });
});
