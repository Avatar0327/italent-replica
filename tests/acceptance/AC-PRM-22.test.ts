/**
 * AC-PRM-22（REQ-PRM-001「字段权限对列表和表单同时生效」；06 §7.2）：字段「查看」取消 →
 * 列表列与表单字段同时不出现。前置条件：用户只持有测试身份（DEC-042：另有身份可见时按并集仍可见）。
 * 各业务模块的列表与表单都用 trimToViewableFields 按同一份有效权限裁剪。
 */
import { trimToViewableFields } from '@italent/domain';
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

describe('AC-PRM-22 取消字段查看 → 列表与表单同时隐藏', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('手机号「查看」取消：有效权限不含该字段，列表行与表单裁剪结果都没有手机号', async () => {
    const testProfile = await createProfile(world, 'test-profile');
    await setObjectPermission(world, testProfile, {
      dataOperations: { create: false, update: true, delete: false },
      fields: [
        { fieldCode: 'Name', view: true, edit: true },
        { fieldCode: 'MobilePhone', view: false, edit: false },
        { fieldCode: 'CreatedBy', view: true, edit: false },
      ],
      buttons: [],
    });
    await makeGrantable(world, [testProfile.id]);
    const user = await addMember(world, 'only-test');
    await grant(world, user.id, testProfile.id);

    const res = await myObject(world, user);
    const effective = (await res.json()) as MyObjectPermission;
    expect(effective.viewableFields.sort()).toEqual(['CreatedBy', 'Name']);
    expect(effective.editableFields).toEqual(['Name']);

    const viewable = {
      objectCode: effective.objectCode,
      dataOperations: effective.dataOperations,
      viewableFields: new Set(effective.viewableFields),
      editableFields: new Set(effective.editableFields),
      grantedButtons: new Set<string>(),
    };
    const row = { Name: '张三', MobilePhone: '13800000000', CreatedBy: 'u-1' };
    const listRow = trimToViewableFields(row, viewable);
    const form = trimToViewableFields({ ...row }, viewable);
    expect(listRow).toEqual({ Name: '张三', CreatedBy: 'u-1' });
    expect(form).toEqual(listRow);
    expect(trimToViewableFields(row, undefined)).toEqual({});
  });
});
