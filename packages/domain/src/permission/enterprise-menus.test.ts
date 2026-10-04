import { describe, expect, it } from 'vitest';
import { type AdminCapability, ADMIN_ROLES, hasAdminCapability } from './admin-roles.js';
import { ENTERPRISE_MENUS, visibleEnterpriseMenus } from './enterprise-menus.js';

const holdersOf = (capability: AdminCapability) => ADMIN_ROLES.filter((role) => hasAdminCapability([role], capability));

describe('企业设置菜单矩阵（06 §7.1）与后端管理员能力一致', () => {
  it('67 行，编码与路径唯一', () => {
    expect(ENTERPRISE_MENUS).toHaveLength(67);
    expect(new Set(ENTERPRISE_MENUS.map((m) => m.code)).size).toBe(67);
    expect(new Set(ENTERPRISE_MENUS.map((m) => m.path)).size).toBe(67);
  });

  it('已实现菜单：可见的管理员 = 读接口能力的持有者；可操作的管理员 ⊆ 可见的管理员', () => {
    for (const menu of ENTERPRISE_MENUS) {
      if (menu.view) expect([...menu.holders].sort(), menu.path).toEqual([...holdersOf(menu.view)].sort());
      if (menu.edit) {
        expect(menu.view, menu.path).toBeDefined();
        for (const role of holdersOf(menu.edit)) expect(menu.holders, menu.path).toContain(role);
      }
    }
  });

  it('流程矩阵与审批中心的流程管理员沿用同一能力（DEC-102，PR #35）', () => {
    for (const path of ['流程矩阵/矩阵管理', '流程矩阵/矩阵设置']) {
      const menu = ENTERPRISE_MENUS.find((m) => m.path === path)!;
      expect([...menu.holders].sort()).toEqual([...holdersOf('process_matrix')].sort());
    }
  });

  it('可见菜单按持有的管理员身份取并集；无身份时为空', () => {
    expect(visibleEnterpriseMenus([])).toEqual([]);
    const audit = visibleEnterpriseMenus(['audit_admin']).map((m) => m.path);
    expect(audit).toContain('权限管理/权限查询');
    expect(audit).not.toContain('许可管理/余额');
    const both = visibleEnterpriseMenus(['audit_admin', 'billing_admin']).map((m) => m.path);
    expect(both).toEqual(expect.arrayContaining(['权限管理/权限查询', '许可管理/余额', '许可管理/使用明细']));
    const system = visibleEnterpriseMenus(['system_admin']);
    expect(system.find((m) => m.path === '权限管理/管理单元')).toMatchObject({ implemented: true, editable: false });
  });
});
