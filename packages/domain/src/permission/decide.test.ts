import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, hasAdminCapability } from './admin-roles.js';
import { buttonResource, decide, type PermissionSubject } from './decide.js';
import type { GrantedObjectPermission } from './effective.js';
import { MODULE_ACTIONS, MODULE_OBJECTS, ORG_EMPLOYEE_APP } from './module-actions.js';
import { ObjectCatalog, validateObjectPermission } from './object-permission.js';

const catalog = new ObjectCatalog([
  ...Object.values(MODULE_OBJECTS),
  { code: 'Other.Obj', application: 'OtherApp', fields: [], buttons: [] },
  {
    code: 'Demo.Obj',
    application: 'Demo',
    fields: [
      { code: 'Name', system: false },
      { code: 'CreatedBy', system: true },
    ],
    buttons: [
      { code: 'Edit', level: 'detail', requires: 'update' },
      { code: 'Print', level: 'detail' },
    ],
  },
]);

const permission = (overrides: Partial<GrantedObjectPermission> = {}): GrantedObjectPermission => ({
  objectCode: 'Demo.Obj',
  dataOperations: { create: false, update: false, delete: false },
  fields: [],
  buttons: [],
  profileApps: ['Demo'],
  ...overrides,
});

const nobody: PermissionSubject = { adminRoles: [], objectPermissions: [] };

describe('decide：默认拒绝', () => {
  it('没有任何身份时，任何动作都拒绝；未知 action / 畸形 resource 拒绝', () => {
    for (const action of ['admin.user_grant', 'object.view', 'object.button', 'tenant.settings.read', 'whatever']) {
      expect(decide(nobody, { action, resource: 'Demo.Obj' }, catalog)).toBe(false);
    }
    const viewer: PermissionSubject = { adminRoles: ['tenant_admin'], objectPermissions: [permission()] };
    expect(decide(viewer, { action: 'admin.no_such' }, catalog)).toBe(false);
    expect(decide(viewer, { action: 'object.view' }, catalog)).toBe(false);
    expect(decide(viewer, { action: 'object.button', resource: 'Demo.Obj#Print' }, catalog)).toBe(false);
  });

  it('对象动作：在对象清单中即可 view；增改删看数据操作开关', () => {
    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [permission({ dataOperations: { create: false, update: true, delete: false } })],
    };
    expect(decide(subject, { action: 'object.view', resource: 'Demo.Obj' }, catalog)).toBe(true);
    expect(decide(subject, { action: 'object.update', resource: 'Demo.Obj', fields: [] }, catalog)).toBe(true);
    expect(decide(subject, { action: 'object.delete', resource: 'Demo.Obj' }, catalog)).toBe(false);
    expect(decide(subject, { action: 'object.view', resource: 'Other.Obj' }, catalog)).toBe(false);
  });

  it('按钮：未登记到对象元数据的按钮一律拒绝', () => {
    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [permission({ buttons: [{ buttonCode: 'Print', level: 'detail' }] })],
    };
    expect(
      decide(subject, { action: 'object.button', resource: buttonResource('Demo.Obj', 'Print', 'detail') }, catalog),
    ).toBe(true);
    const unknownObject = buttonResource('Nope.Obj', 'Print', 'detail');
    expect(decide(subject, { action: 'object.button', resource: unknownObject }, catalog)).toBe(false);
  });

  it('R1-T00 租户配置动作只给租户管理员', () => {
    for (const role of ADMIN_ROLES) {
      const allowed = decide(
        { adminRoles: [role], objectPermissions: [] },
        { action: 'tenant.settings.write' },
        catalog,
      );
      expect(allowed, role).toBe(role === 'tenant_admin');
    }
  });
});

describe('8 类管理员能力矩阵（06 §7.1）抽查', () => {
  it('职责分离：审计只看日志与权限查询，计费只看许可，矩阵只管流程矩阵', () => {
    expect(hasAdminCapability(['audit_admin'], 'audit_log')).toBe(true);
    expect(hasAdminCapability(['audit_admin'], 'user_grant')).toBe(false);
    expect(hasAdminCapability(['billing_admin'], 'license_usage')).toBe(true);
    expect(hasAdminCapability(['billing_admin'], 'profile_manage')).toBe(false);
    expect(hasAdminCapability(['matrix_admin'], 'process_matrix')).toBe(true);
    expect(hasAdminCapability(['system_admin'], 'dynamic_grant')).toBe(false);
    expect(hasAdminCapability(['system_admin'], 'license_usage')).toBe(false);
    expect(hasAdminCapability(['system_admin', 'billing_admin'], 'license_usage')).toBe(true);
  });
});

describe('validateObjectPermission', () => {
  it('系统字段只能授查看；重复与未知的字段、按钮都报出', () => {
    const definition = catalog.get('Demo.Obj')!;
    expect(
      validateObjectPermission(definition, {
        dataOperations: { create: false, update: false, delete: false },
        fields: [
          { fieldCode: 'CreatedBy', view: true, edit: false },
          { fieldCode: 'Name', view: true, edit: true },
          { fieldCode: 'Name', view: true, edit: true },
        ],
        buttons: [
          { buttonCode: 'Print', level: 'list' },
          { buttonCode: 'Print', level: 'detail' },
        ],
      }),
    ).toEqual([
      { reason: 'DUPLICATE_FIELD', fieldCode: 'Name' },
      { reason: 'UNKNOWN_BUTTON', buttonCode: 'Print', level: 'list' },
    ]);
  });

  it('同一对象编码登记不同定义 → 报错', () => {
    expect(() => catalog.register({ code: 'Demo.Obj', application: 'Demo', fields: [], buttons: [] })).toThrow(
      /已登记/,
    );
  });
});

describe('应用边界（Codex 审计 PR #8 #1）', () => {
  it('身份未登记对象所属应用时，它的对象权限不生效（view / 增改删 / 按钮都拒绝）', () => {
    const granted = permission({
      dataOperations: { create: true, update: true, delete: true },
      buttons: [{ buttonCode: 'Print', level: 'detail' }],
    });
    const outside: PermissionSubject = { adminRoles: [], objectPermissions: [{ ...granted, profileApps: ['X'] }] };
    const inside: PermissionSubject = { adminRoles: [], objectPermissions: [granted] };
    const print = buttonResource('Demo.Obj', 'Print', 'detail');
    for (const [subject, expected] of [
      [outside, false],
      [inside, true],
    ] as const) {
      expect(decide(subject, { action: 'object.view', resource: 'Demo.Obj' }, catalog)).toBe(expected);
      expect(decide(subject, { action: 'object.delete', resource: 'Demo.Obj' }, catalog)).toBe(expected);
      expect(decide(subject, { action: 'object.button', resource: print }, catalog)).toBe(expected);
    }
  });

  it('同一用户两个身份：只有登记了该应用的那个身份计入并集', () => {
    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [
        permission({ dataOperations: { create: false, update: false, delete: true }, profileApps: ['X'] }),
        permission({ profileApps: ['Demo', 'X'] }),
      ],
    };
    expect(decide(subject, { action: 'object.view', resource: 'Demo.Obj' }, catalog)).toBe(true);
    expect(decide(subject, { action: 'object.delete', resource: 'Demo.Obj' }, catalog)).toBe(false);
  });

  it('未登记到对象目录的对象一律拒绝', () => {
    const subject: PermissionSubject = {
      adminRoles: [],
      objectPermissions: [permission({ objectCode: 'Ghost.Obj' })],
    };
    expect(decide(subject, { action: 'object.view', resource: 'Ghost.Obj' }, catalog)).toBe(false);
  });
});

describe('写入字段权限（Codex 审计 PR #8 #2）', () => {
  const editor = (fields: GrantedObjectPermission['fields']): GrantedObjectPermission =>
    permission({ dataOperations: { create: true, update: true, delete: false }, fields });
  const update = (subject: PermissionSubject, fields?: string[]) =>
    decide(subject, { action: 'object.update', resource: 'Demo.Obj', fields }, catalog);

  it('新增 / 编辑不带字段集合 → 拒绝；带了就逐字段校验', () => {
    const subject: PermissionSubject = { adminRoles: [], objectPermissions: [editor([])] };
    expect(update(subject)).toBe(false);
    expect(decide(subject, { action: 'object.create', resource: 'Demo.Obj' }, catalog)).toBe(false);
    expect(update(subject, [])).toBe(true);
    expect(update(subject, ['Name'])).toBe(false);
  });

  it('全部身份都不可编辑的字段、系统字段、未登记字段写入被拒；任一身份可编辑即可写（DEC-042）', () => {
    const viewOnly = editor([{ fieldCode: 'Name', view: true, edit: false }]);
    const canEdit = editor([{ fieldCode: 'Name', view: true, edit: true }]);
    // 库里脏数据：系统字段被标了可编辑，判定时仍不可写
    const dirty = editor([{ fieldCode: 'CreatedBy', view: true, edit: true }]);
    expect(update({ adminRoles: [], objectPermissions: [viewOnly] }, ['Name'])).toBe(false);
    expect(update({ adminRoles: [], objectPermissions: [viewOnly, canEdit] }, ['Name'])).toBe(true);
    expect(update({ adminRoles: [], objectPermissions: [canEdit, dirty] }, ['Name', 'CreatedBy'])).toBe(false);
    expect(update({ adminRoles: [], objectPermissions: [canEdit] }, ['Nope'])).toBe(false);
  });

  it('可编辑但数据操作关闭 → 拒绝', () => {
    const closed = permission({ fields: [{ fieldCode: 'Name', view: true, edit: true }] });
    expect(update({ adminRoles: [], objectPermissions: [closed] }, ['Name'])).toBe(false);
  });
});

describe('已上线模块的路由动作（R1-T03/T04/T05 接入）', () => {
  const moduleGrant = (objectCode: string, update: boolean): GrantedObjectPermission => ({
    objectCode,
    dataOperations: { create: false, update, delete: false },
    fields: [],
    buttons: [],
    profileApps: [ORG_EMPLOYEE_APP],
  });

  it('每个 tenant.<模块>.* 动作都已登记；无身份一律拒绝', () => {
    for (const action of Object.keys(MODULE_ACTIONS)) {
      expect(decide(nobody, { action, resource: 'any' }, catalog), action).toBe(false);
    }
    expect(decide(nobody, { action: 'tenant.unknown.read' }, catalog)).toBe(false);
  });

  it('读 = 对象在身份对象清单中；写 = 编辑开关；应用边界同样生效', () => {
    for (const object of Object.values(MODULE_OBJECTS)) {
      const actions = Object.entries(MODULE_ACTIONS).filter(
        ([, a]) => a.kind === 'object' && a.objectCode === object.code,
      );
      const readAction = actions.find(([, a]) => a.kind === 'object' && a.operation === 'view')![0];
      const writeAction = actions.find(([, a]) => a.kind === 'object' && a.operation === 'update')![0];
      const viewer: PermissionSubject = { adminRoles: [], objectPermissions: [moduleGrant(object.code, false)] };
      const editor: PermissionSubject = { adminRoles: [], objectPermissions: [moduleGrant(object.code, true)] };
      const outside: PermissionSubject = {
        adminRoles: [],
        objectPermissions: [{ ...moduleGrant(object.code, true), profileApps: ['OtherApp'] }],
      };
      expect(decide(viewer, { action: readAction }, catalog), readAction).toBe(true);
      expect(decide(viewer, { action: writeAction }, catalog), writeAction).toBe(false);
      expect(decide(editor, { action: writeAction }, catalog), writeAction).toBe(true);
      expect(decide(outside, { action: readAction }, catalog), readAction).toBe(false);
    }
  });

  it('模块配置类动作只给租户管理员（需取证 #7）', () => {
    for (const action of ['tenant.settings.read', 'tenant.employment.configuration.write']) {
      for (const role of ADMIN_ROLES) {
        expect(decide({ adminRoles: [role], objectPermissions: [] }, { action }, catalog), role).toBe(
          role === 'tenant_admin',
        );
      }
    }
  });
});
