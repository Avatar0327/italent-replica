/**
 * AC-PRM-19（REQ-PRM-001 R5；06 §7.2）：两身份对同一对象的功能按钮不同。
 * 人事管理员可见「调动」等直接执行按钮；部门负责人只见「调动申请」、打印类按钮。
 * 直改制与申请制由身份持有哪类按钮决定；后端授权器按「按钮编码 × 级别」判定，与前台可见性一致。
 */
import { createPermissionAuthorizer } from '@italent/api';
import { buttonResource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  DEMO_OBJECT,
  grant,
  makeGrantable,
  myObject,
  type MyObjectPermission,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';

const testDb = useTestDb();

describe('AC-PRM-19 不同身份的功能按钮不同', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('人事管理员见「调动」直接执行；部门负责人只见「调动申请」与打印；后端判定一致', async () => {
    const ops = { create: true, update: true, delete: true };
    const hrProfile = await createProfile(world, 'hr-admin');
    const leaderProfile = await createProfile(world, 'dept-leader');
    await setObjectPermission(world, hrProfile, {
      dataOperations: ops,
      fields: [],
      buttons: [
        { buttonCode: 'Employment.Tranfer', level: 'list_row' },
        { buttonCode: 'EmploymentRecord.TransferApproval', level: 'list_row' },
        { buttonCode: 'EmploymentRecord.Print', level: 'detail' },
      ],
    });
    await setObjectPermission(world, leaderProfile, {
      dataOperations: ops,
      fields: [],
      buttons: [
        { buttonCode: 'EmploymentRecord.TransferApproval', level: 'list_row' },
        { buttonCode: 'EmploymentRecord.Print', level: 'detail' },
      ],
    });
    await makeGrantable(world, [hrProfile.id, leaderProfile.id]);
    const hr = await addMember(world, 'hr');
    const leader = await addMember(world, 'leader');
    await grant(world, hr.id, hrProfile.id);
    await grant(world, leader.id, leaderProfile.id);

    const codes = async (userId: typeof hr) =>
      ((await (await myObject(world, userId)).json()) as MyObjectPermission).buttons.map((b) => b.buttonCode).sort();
    expect(await codes(hr)).toEqual([
      'Employment.Tranfer',
      'EmploymentRecord.Print',
      'EmploymentRecord.TransferApproval',
    ]);
    expect(await codes(leader)).toEqual(['EmploymentRecord.Print', 'EmploymentRecord.TransferApproval']);

    const authorize = createPermissionAuthorizer(world.db);
    const transfer = buttonResource(DEMO_OBJECT.code, 'Employment.Tranfer', 'list_row');
    const ask = (userId: string) =>
      authorize({ userId, tenantId: world.tenant.id, action: 'object.button', resource: transfer });
    expect(await ask(hr.id)).toBe(true);
    expect(await ask(leader.id)).toBe(false);
    // 级别不同即不同按钮：列表行上的按钮不等于详情页上的同名按钮
    const otherLevel = buttonResource(DEMO_OBJECT.code, 'Employment.Tranfer', 'detail');
    expect(
      await authorize({ userId: hr.id, tenantId: world.tenant.id, action: 'object.button', resource: otherLevel }),
    ).toBe(false);
  });
});
