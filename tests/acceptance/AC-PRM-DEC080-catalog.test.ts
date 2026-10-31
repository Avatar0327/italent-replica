import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { trimModuleResponse } from '../../apps/api/src/modules/permission/module-access.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  type MyObjectPermission,
  myObject,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import {
  buttonResource,
  decide,
  PERSONNEL_OBJECT,
  PERSONNEL_OBJECTS,
  MODULE_OBJECTS,
  ObjectCatalog,
  type PermissionSubject,
} from '@italent/domain';

const testDb = useTestDb();

describe('DEC-080 real module catalogs and fail-closed writes', () => {
  it('AC-PER-F325 日工资标准登记为可独立授予编辑权的档案字段', () => {
    const object = PERSONNEL_OBJECTS.find((item) => item.code === PERSONNEL_OBJECT)!;
    expect(object.fields.filter((field) => field.code === 'dailyWageStandard')).toEqual([
      { code: 'dailyWageStandard', system: false },
    ]);
  });

  it('AC-PRM-DEC080 F-222 / F-225：Offer 批量审批单只登记两个详情页不同意按钮，按“新增”控制（DEC-704）', () => {
    expect(MODULE_OBJECTS.offerBatchApproval.buttons).toEqual([
      { code: 'PartDisAgree', level: 'detail', requires: 'create' },
      { code: 'AllDisAgree', level: 'detail', requires: 'create' },
    ]);
  });

  // F-225（DEC-704）：原站两按钮事件类型为“创建”。只开新增 → 可见可执行；只开编辑不开新增 → 不可见、授权器拒绝。
  it.each([
    ['只开新增', true, { create: true, update: false, delete: false }],
    ['只开编辑', false, { create: false, update: true, delete: false }],
  ] as const)('AC-PRM-DEC080 F-225：%s → 两个不同意按钮可见 = %s', async (label, visible, dataOperations) => {
    const definition = MODULE_OBJECTS.offerBatchApproval;
    const world = await seedPermissionWorld(testDb().db);
    const profile = await createProfile(world, `f225${dataOperations.create ? 'create' : 'update'}`);
    const buttons = definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level }));
    const set = await setObjectPermission(
      world,
      profile,
      {
        dataOperations,
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        buttons,
      },
      definition.code,
    );
    expect(set.status, await set.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, label);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);

    const res = await myObject(world, user, definition.code);
    expect(res.status, await res.clone().text()).toBe(200);
    const mine = (await res.json()) as MyObjectPermission;
    expect(mine.dataOperations).toEqual(dataOperations);
    expect(mine.buttons).toHaveLength(visible ? buttons.length : 0);
    expect(mine.buttons).toEqual(expect.arrayContaining(visible ? buttons : []));

    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [
        { objectCode: definition.code, profileApps: [definition.application], dataOperations, fields: [], buttons },
      ],
    };
    const catalog = new ObjectCatalog(Object.values(MODULE_OBJECTS));
    for (const { buttonCode, level } of buttons) {
      const resource = buttonResource(definition.code, buttonCode, level);
      expect(decide(subject, { action: 'object.button', resource }, catalog), buttonCode).toBe(visible);
    }
  });

  it('registers actual fields and buttons, with system fields never editable', () => {
    for (const definition of Object.values(MODULE_OBJECTS)) {
      expect(definition.fields.length, definition.code).toBeGreaterThan(0);
      expect(definition.buttons.length, definition.code).toBeGreaterThan(0);
      expect(definition.fields.find((f) => f.code === 'id')?.system, definition.code).toBe(true);
    }
  });

  it('does not turn an omitted write field list into an empty valid write', () => {
    const definition = MODULE_OBJECTS.organization;
    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [
        {
          objectCode: definition.code,
          profileApps: [definition.application],
          dataOperations: { create: false, update: true, delete: false },
          fields: [],
          buttons: [],
        },
      ],
    };
    const catalog = new ObjectCatalog(Object.values(MODULE_OBJECTS));
    expect(decide(subject, { action: 'tenant.org.write' }, catalog)).toBe(false);
    expect(decide(subject, { action: 'tenant.org.create', fields: [] }, catalog)).toBe(false);
    expect(decide(subject, { action: 'tenant.org.delete' }, catalog)).toBe(false);
  });

  it('keeps validation envelopes outside the configurable organization business-field catalog', async () => {
    const fields = MODULE_OBJECTS.organization.fields.map((field) => field.code);
    expect(fields).not.toEqual(expect.arrayContaining(['valid', 'errors', 'warnings', 'label']));
    expect(fields).not.toEqual(expect.arrayContaining(['enabledDimensions', 'fullNameStartLevel']));

    const result = await trimModuleResponse(
      { authorize: async () => false, db: {} as never, clock: () => new Date('2026-10-02T00:00:00Z') },
      { tenantId: 'tenant', userId: 'user', timezone: 'Asia/Shanghai' },
      MODULE_OBJECTS.organization.code,
      { valid: false, errors: ['name'], warnings: [], canSubmit: false, name: 'hidden' },
    );
    expect(result).toEqual({ valid: false, errors: ['name'], warnings: [], canSubmit: false });
  });
});
