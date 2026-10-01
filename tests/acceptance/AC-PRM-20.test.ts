/**
 * AC-PRM-20（REQ-PRM-001 R6；DEC-042）：按钮已勾选，但对象「编辑」数据操作权限关闭。
 * 前置条件：用户只持有测试身份。复刻做法：按钮不出现在可执行按钮中（前台隐藏），后端提交同样拒绝。
 * 另一身份开启了「编辑」时按并集放行（DEC-042，与原站 A1 实测一致）。
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

describe('AC-PRM-20 按钮勾选 ∧ 数据操作开启 才可执行', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('只持有测试身份：编辑按钮已勾选但「编辑」关闭 → 不可见、后端拒绝；叠加开启编辑的身份后放行', async () => {
    const testProfile = await createProfile(world, 'test-profile');
    const editor = await createProfile(world, 'editor');
    await setObjectPermission(world, testProfile, {
      dataOperations: { create: true, update: false, delete: true },
      fields: [{ fieldCode: 'Name', view: true, edit: true }],
      buttons: [
        { buttonCode: 'EmploymentRecord.Edit', level: 'detail' },
        { buttonCode: 'EmploymentRecord.Print', level: 'detail' },
      ],
    });
    await setObjectPermission(world, editor, {
      dataOperations: { create: false, update: true, delete: false },
      fields: [],
      buttons: [],
    });
    await makeGrantable(world, [testProfile.id, editor.id]);
    const user = await addMember(world, 'only-test');
    await grant(world, user.id, testProfile.id);

    const authorize = createPermissionAuthorizer(world.db);
    const edit = buttonResource(DEMO_OBJECT.code, 'EmploymentRecord.Edit', 'detail');
    const base = { userId: user.id, tenantId: world.tenant.id };

    const before = (await (await myObject(world, user)).json()) as MyObjectPermission;
    expect(before.buttons.map((b) => b.buttonCode)).toEqual(['EmploymentRecord.Print']);
    expect(await authorize({ ...base, action: 'object.button', resource: edit })).toBe(false);
    expect(await authorize({ ...base, action: 'object.update', resource: DEMO_OBJECT.code })).toBe(false);
    expect(await authorize({ ...base, action: 'object.delete', resource: DEMO_OBJECT.code })).toBe(true);

    await grant(world, user.id, editor.id);
    const after = (await (await myObject(world, user)).json()) as MyObjectPermission;
    expect(after.buttons.map((b) => b.buttonCode).sort()).toEqual(['EmploymentRecord.Edit', 'EmploymentRecord.Print']);
    expect(await authorize({ ...base, action: 'object.button', resource: edit })).toBe(true);
  });
});
