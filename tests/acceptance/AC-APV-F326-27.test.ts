/**
 * AC-APV-F326-27（F-326 S1 守卫，设计 §2.4 / §4.3 / §7）：
 * ① 企业设置菜单 matrix.manage 的持有角色与管理员能力 process_matrix（CAPABILITY_HOLDERS['admin.process_matrix']）一致；
 * ② APPROVAL_TYPE_APPS 覆盖全部审批类型，且类型的对象在该应用目录内（不在任何应用目录的类型须显式登记豁免）。
 * 另核对四个审计对象类型的中文标签、配置类登记、row.delete → 删除操作映射。
 */
import {
  ADMIN_ROLES,
  APPROVAL_TYPES,
  APPROVAL_TYPES_OUTSIDE_APP_DIRECTORY,
  APPROVAL_TYPE_APPS,
  APP_IDS,
  APP_OBJECT_DIRECTORY,
  AUDIT_CONFIG_OBJECT_TYPES,
  ENTERPRISE_MENUS,
  auditObjectMeta,
  auditOperationOf,
  hasAdminCapability,
  visibleEnterpriseMenus,
} from '@italent/domain';
import { auditObjectRegistered } from '../../apps/api/src/audit/visibility.js';
import { describe, expect, it } from 'vitest';

describe('matrix.manage ↔ admin.process_matrix', () => {
  const holders = ADMIN_ROLES.filter((role) => hasAdminCapability([role], 'process_matrix'));

  it('按菜单编码（不靠路径文案）核对：持有角色与 process_matrix 的持有者完全一致', () => {
    const menu = ENTERPRISE_MENUS.find((m) => m.code === 'matrix.manage');
    expect(menu, 'matrix.manage 菜单存在').toBeDefined();
    expect([...menu!.holders].sort()).toEqual([...holders].sort());
    expect([...holders].sort()).toEqual(['matrix_admin', 'system_admin', 'tenant_admin']);
  });

  it('矩阵设置菜单同口径（不新增授权项：沿用同一管理员能力）', () => {
    const menu = ENTERPRISE_MENUS.find((m) => m.code === 'matrix.settings');
    expect([...menu!.holders].sort()).toEqual([...holders].sort());
  });

  it('DEC-907：matrix.manage 登记读 / 写能力 process_matrix；持有者可操作，非持有者看不到入口', () => {
    const menu = ENTERPRISE_MENUS.find((m) => m.code === 'matrix.manage');
    expect(menu).toMatchObject({ view: 'process_matrix', edit: 'process_matrix' });
    for (const role of holders)
      expect(
        visibleEnterpriseMenus([role]).find((m) => m.code === 'matrix.manage'),
        role,
      ).toEqual({
        code: 'matrix.manage',
        path: '流程矩阵/矩阵管理',
        implemented: true,
        editable: true,
      });
    for (const role of ADMIN_ROLES.filter((r) => !holders.includes(r)))
      expect(
        visibleEnterpriseMenus([role]).map((m) => m.code),
        role,
      ).not.toContain('matrix.manage');
    // 矩阵设置不在 DEC-907 范围内：仍只保留入口
    expect(ENTERPRISE_MENUS.find((m) => m.code === 'matrix.settings')?.view).toBeUndefined();
  });
});

describe('APPROVAL_TYPE_APPS', () => {
  const codes = Object.keys(APPROVAL_TYPES);

  it('覆盖全部审批类型，不多不少，值都是合法应用', () => {
    expect(Object.keys(APPROVAL_TYPE_APPS).sort()).toEqual([...codes].sort());
    for (const app of Object.values(APPROVAL_TYPE_APPS)) expect(APP_IDS).toContain(app);
  });

  it('类型的对象在其映射应用的目录内（不从目录反推：同一对象可出现在多个应用里）', () => {
    const missing = Object.entries(APPROVAL_TYPE_APPS)
      .filter(([code]) => !APPROVAL_TYPES_OUTSIDE_APP_DIRECTORY.includes(code as never))
      .filter(
        ([code, app]) =>
          !APP_OBJECT_DIRECTORY[app].includes(APPROVAL_TYPES[code as keyof typeof APPROVAL_TYPES].objectCode),
      )
      .map(([code, app]) => `${code}→${app}`);
    expect(missing).toEqual([]);
  });

  it('豁免清单只含确实不在任何应用目录的类型（防止过期豁免掩盖映射错误）', () => {
    for (const code of APPROVAL_TYPES_OUTSIDE_APP_DIRECTORY) {
      const object = APPROVAL_TYPES[code].objectCode;
      const hosts = APP_IDS.filter((app) => APP_OBJECT_DIRECTORY[app].includes(object));
      expect(hosts, `${code} 的对象 ${object} 已在目录里，应取消豁免`).toEqual([]);
    }
    expect(APPROVAL_TYPES_OUTSIDE_APP_DIRECTORY).toEqual(['org_adjustment']);
  });
});

describe('四个审计对象类型（设计 §4.5）', () => {
  const types: [string, string][] = [
    ['approval-public-variable', '公共变量'],
    ['approval-application-variable', '应用变量'],
    ['approval-matrix', '审批矩阵'],
    ['approval-matrix-row', '审批矩阵规则行'],
  ];

  it.each(types)('%s：中文标签 %s，归属审批应用，属 DEC-203 配置类，查看规则已登记', (type, label) => {
    const meta = auditObjectMeta(type);
    expect(meta.label).toBe(label);
    expect(meta.app).toBe(auditObjectMeta('approval-process').app);
    expect(AUDIT_CONFIG_OBJECT_TYPES.has(type)).toBe(true);
    expect(auditObjectRegistered(type)).toBe(true);
  });

  it('approval.matrix.row.delete 归为删除操作（审计详情返回删除快照）；其他动作不被误归', () => {
    expect(auditOperationOf('approval.matrix.row.delete', { seq: 1 }, null)).toBe('delete');
    expect(auditOperationOf('approval.matrix.row.delete', { seq: 1 }, {})).toBe('delete');
    expect(auditOperationOf('approval.matrix.structure', { 'row:a': { seq: 1 } }, { 'row:a': { seq: 2 } })).toBe(
      'update',
    );
    expect(auditOperationOf('approval.public_variable.create', null, { name: '甲' })).toBe('create');
    expect(auditOperationOf('approval.public_variable.disable', { status: 'enabled' }, { status: 'disabled' })).toBe(
      'update',
    );
  });
});
