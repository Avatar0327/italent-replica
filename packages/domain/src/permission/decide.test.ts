import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, hasAdminCapability } from './admin-roles.js';
import { buttonResource, decide, type PermissionSubject } from './decide.js';
import { ObjectCatalog, type ObjectPermission, validateObjectPermission } from './object-permission.js';

const catalog = new ObjectCatalog([
  {
    code: 'Demo.Obj',
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

const permission = (overrides: Partial<ObjectPermission> = {}): ObjectPermission => ({
  objectCode: 'Demo.Obj',
  dataOperations: { create: false, update: false, delete: false },
  fields: [],
  buttons: [],
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
    expect(decide(subject, { action: 'object.update', resource: 'Demo.Obj' }, catalog)).toBe(true);
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
    expect(() => catalog.register({ code: 'Demo.Obj', fields: [], buttons: [] })).toThrow(/已登记/);
  });
});
