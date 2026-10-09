/**
 * AC-PRM-FW-08（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-08「授权替身」；DEC-356 / 359 / 362）：
 * 授权替身与"请求 ↔ 权限键"映射的自检。替身只在测试里替换 createApp 的 authorize，并经 registerScopeProvider 登记
 * 范围 / 字段提供器；处理函数一行不动（PR-B 零行为变化，§1.2）。
 */
import type { AuthorizationRequest } from '@italent/api';
import type { Tx } from '@italent/db';
import { MODULE_ACTIONS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScope,
  scopeAllows,
} from '../../apps/api/src/modules/permission/module-access.js';
import { createAuthorizerDouble } from './support/route-policy/double.js';
import { mapRequest, permClaims } from './support/route-policy/request-perms.js';

const ctx = { tenantId: '00000000-0000-4000-8000-0000000000aa', userId: '00000000-0000-4000-8000-0000000000bb' };
const timezoneCtx = { ...ctx, timezone: 'Asia/Shanghai' };
const clock = () => new Date('2026-03-01T04:00:00Z');
const deps = (authorize: ReturnType<typeof createAuthorizerDouble>['authorize']) => ({
  authorize,
  clock,
  db: undefined as never,
});
const req = (action: string, resource?: string, fields?: readonly string[]): AuthorizationRequest => ({
  ...timezoneCtx,
  action,
  ...(resource ? { resource } : {}),
  ...(fields ? { fields } : {}),
});
const EMP = 'TenantBase.EmploymentRecord';

describe('AC-PRM-FW-08 请求 ↔ 权限键映射（request-perms）', () => {
  it('object.<op> / object.button / admin.<能力> 映射到 obj: / btn: / admin: 键', () => {
    expect(mapRequest(req('object.view', EMP))).toEqual({ kind: 'perm', key: `obj:${EMP}:view` });
    expect(mapRequest(req('object.create', EMP, ['a']))).toEqual({ kind: 'perm', key: `obj:${EMP}:create` });
    expect(mapRequest(req('object.update', EMP, []))).toEqual({ kind: 'perm', key: `obj:${EMP}:update` });
    expect(mapRequest(req('object.delete', EMP))).toEqual({ kind: 'perm', key: `obj:${EMP}:delete` });
    expect(mapRequest(req('object.button', `${EMP}#Transfer.Hr@detail`))).toEqual({
      kind: 'perm',
      key: `btn:${EMP}#Transfer.Hr@detail`,
    });
    expect(mapRequest(req('admin.other_settings'))).toEqual({ kind: 'perm', key: 'admin:other_settings' });
  });

  it('tenant.* 别名取 @italent/domain 的 MODULE_ACTIONS（不手抄）：每个别名都映射到同一对象 / 能力', () => {
    for (const [action, target] of Object.entries(MODULE_ACTIONS)) {
      const expected =
        target.kind === 'admin' ? `admin:${target.capability}` : `obj:${target.objectCode}:${target.operation}`;
      expect(mapRequest(req(action, undefined, [])), action).toEqual({ kind: 'perm', key: expected });
    }
    expect(Object.keys(MODULE_ACTIONS).length).toBeGreaterThan(10);
  });

  it('data.scope.all 是范围查询，不是权限键；映射不了的动作 / 坏按钮资源 → unmapped（PROBE_ACTION_UNMAPPED）', () => {
    expect(mapRequest(req('data.scope.all', EMP))).toEqual({ kind: 'scope', key: `scope:data.scope.all:${EMP}` });
    expect(mapRequest(req('survey360.sheet.delete')).kind).toBe('unmapped');
    expect(mapRequest(req('object.button', 'not-a-button-resource')).kind).toBe('unmapped');
    expect(mapRequest(req('object.view')).kind).toBe('unmapped'); // 缺资源
    // 删掉别名表 → tenant.* 不再可映射（审查反例：删映射）
    expect(mapRequest(req('tenant.employment.read'), {}).kind).toBe('unmapped');
  });
});

describe('AC-PRM-FW-08 permClaims：表里的权限键认领请求键（含集合 / 映射函数 / 记录定位）', () => {
  it('精确键、对象集合、操作集合、按钮集合', () => {
    expect(permClaims(`obj:${EMP}:view`, `obj:${EMP}:view`)).toBe(true);
    expect(permClaims(`obj:${EMP}:view`, `obj:${EMP}:update`)).toBe(false);
    expect(permClaims(`obj:${EMP}:{create,update}`, `obj:${EMP}:update`)).toBe(true);
    expect(permClaims(`obj:{A.One,A.Two}:view`, 'obj:A.Two:view')).toBe(true);
    expect(permClaims(`obj:{A.One,A.Two}:view`, 'obj:A.Three:view')).toBe(false);
    expect(
      permClaims(`btn:${EMP}#{Employment.Create@detail,Employment.Edit@detail}`, `btn:${EMP}#Employment.Edit@detail`),
    ).toBe(true);
    expect(permClaims(`btn:${EMP}#Transfer.Hr@detail`, `btn:${EMP}#Transfer.Manager@detail`)).toBe(false);
    expect(permClaims('admin:other_settings', 'admin:other_settings')).toBe(true);
    expect(permClaims('admin:other_settings', 'admin:audit_log')).toBe(false);
  });

  it('{mapper:…} / {record:…} 是运行时求值的占位：该位置认领任意取值；btn:self 认领任意对象的同名按钮', () => {
    expect(
      permClaims('obj:TenantBase.Organization:{mapper:org.importRowOperation}', 'obj:TenantBase.Organization:create'),
    ).toBe(true);
    expect(permClaims('obj:{record:approval.taskObject.fieldObjectCode}:view', 'obj:IDP.Idp:view')).toBe(true);
    expect(permClaims('obj:{record:approval.taskObject.fieldObjectCode}:view', 'obj:IDP.Idp:update')).toBe(false);
    expect(
      permClaims(
        'btn:TenantBase.EmploymentContract#{mapper:contracts.commandButton}',
        'btn:TenantBase.EmploymentContract#renew@detail',
      ),
    ).toBe(true);
    expect(
      permClaims('btn:TenantBase.EmploymentContract#{mapper:contracts.commandButton}', `btn:${EMP}#renew@detail`),
    ).toBe(false);
    expect(permClaims('btn:self#Transfer.Self@detail', `btn:${EMP}#Transfer.Self@detail`)).toBe(true);
  });

  it('非授权器维度（rel / guard / own / self / exception）从不认领授权器请求', () => {
    for (const key of ['rel:idp.executor', 'guard:employment.linkage', 'own:idp.participant', 'self', 'exception:x']) {
      expect(permClaims(key, `obj:${EMP}:view`), key).toBe(false);
    }
  });
});

describe('AC-PRM-FW-08 授权替身：集内允许、集外拒绝，全部记录', () => {
  it('全允许模式：全部允许并记录 action / resource / fields / 映射结果', async () => {
    const double = createAuthorizerDouble();
    expect(await double.authorize(req('object.update', EMP, ['status']))).toBe(true);
    expect(await double.authorize(req('survey360.sheet.delete'))).toBe(true);
    expect(double.requests).toHaveLength(2);
    expect(double.requests[0]).toMatchObject({
      via: 'authorize',
      action: 'object.update',
      resource: EMP,
      fields: ['status'],
      allowed: true,
      mapped: { kind: 'perm', key: `obj:${EMP}:update` },
    });
    expect(double.permKeys()).toEqual([`obj:${EMP}:update`]);
    expect(double.unmapped()).toEqual(['survey360.sheet.delete']);
  });

  it('授权集模式：集内允许、集外拒绝（含 unmapped 一律拒绝，fail-closed）', async () => {
    const double = createAuthorizerDouble({ grants: [`obj:${EMP}:view`] });
    expect(await double.authorize(req('object.view', EMP))).toBe(true);
    expect(await double.authorize(req('object.update', EMP, []))).toBe(false);
    expect(await double.authorize(req('admin.other_settings'))).toBe(false);
    expect(await double.authorize(req('survey360.sheet.delete'))).toBe(false);
    expect(double.requests.map((r) => r.allowed)).toEqual([true, false, false, false]);
  });

  it('revoke：在全允许或授权集模式下单独撤一个键，其余不变', async () => {
    const double = createAuthorizerDouble();
    double.revoke(`obj:${EMP}:view`);
    expect(await double.authorize(req('object.view', EMP))).toBe(false);
    expect(await double.authorize(req('object.update', EMP, []))).toBe(true);
    // 别名与规范键是同一个键：撤 obj:…:view 同样拒绝 tenant.employment.read
    expect(await double.authorize(req('tenant.employment.read', undefined, []))).toBe(false);
  });

  it('事务内授权（authorizeInTransaction → provider.authorize）同样回答、同样记录；集外同样被拒', async () => {
    const double = createAuthorizerDouble({ grants: [`obj:${EMP}:view`] });
    const bound = authorizeInTransaction(double.authorize, {} as Tx);
    expect(bound).not.toBe(double.authorize);
    expect(await bound(req('object.view', EMP))).toBe(true);
    expect(await bound(req('object.delete', EMP))).toBe(false);
    expect(double.requests.map((r) => [r.via, r.allowed])).toEqual([
      ['transaction', true],
      ['transaction', false],
    ]);
  });

  it('范围提供器：all / 空 / 指定组织；记录每次查询（appCode / objectCode / pageCode）', async () => {
    const double = createAuthorizerDouble({ scope: 'all' });
    const all = await resolveModuleScope(deps(double.authorize), timezoneCtx, undefined, EMP, 'page.x');
    expect(all).toMatchObject({ all: true, hasDataPermission: true });
    double.configure({ scope: 'empty' });
    const empty = await resolveModuleScope(deps(double.authorize), timezoneCtx, undefined, EMP);
    expect(empty).toMatchObject({ all: false, hasDataPermission: false, orgIds: [] });
    expect(scopeAllows(empty, { orgId: 'o1' })).toBe(false);
    double.configure({ scope: { orgIds: ['o1'] } });
    const some = await resolveModuleScope(deps(double.authorize), timezoneCtx, undefined, EMP);
    expect(scopeAllows(some, { orgId: 'o1' })).toBe(true);
    expect(scopeAllows(some, { orgId: 'o2' })).toBe(false);
    expect(double.scopeQueries).toHaveLength(3);
    expect(double.scopeQueries[0]).toMatchObject({ objectCode: EMP, pageCode: 'page.x', appCode: 'TenantBase' });
    expect(double.scopeQueries[0]!.asOf).toBe('2026-03-01'); // 租户时区日期，不是浏览器时区
  });

  it('字段提供器：缺省全部可见；隐藏整个对象 → 空集；隐藏某字段 → 仅去掉该字段；记录查询', async () => {
    const double = createAuthorizerDouble();
    const full = await getModuleViewableFields(deps(double.authorize), timezoneCtx, EMP);
    expect(full).toBeDefined();
    expect(full!.has('status')).toBe(true);
    double.configure({ fields: { hideFields: { [EMP]: ['status'] } } });
    const without = await getModuleViewableFields(deps(double.authorize), timezoneCtx, EMP);
    expect(without!.has('status')).toBe(false);
    expect(without!.has('entryDate')).toBe(true);
    double.configure({ fields: { hideObjects: [EMP] } });
    expect([...(await getModuleViewableFields(deps(double.authorize), timezoneCtx, EMP))!]).toEqual([]);
    expect(double.fieldQueries.map((q) => q.objectCode)).toEqual([EMP, EMP, EMP]);
  });

  it('reset 只清记录，不清配置', async () => {
    const double = createAuthorizerDouble({ grants: [`obj:${EMP}:view`] });
    await double.authorize(req('object.view', EMP));
    double.reset();
    expect(double.requests).toEqual([]);
    expect(await double.authorize(req('object.view', EMP))).toBe(true);
    expect(await double.authorize(req('object.update', EMP, []))).toBe(false);
  });
});
