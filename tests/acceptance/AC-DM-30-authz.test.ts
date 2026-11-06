/**
 * AC-DM-30-13～15：历史离职导入权限链的返工回归（F-139a 第 2 轮，设计 §5.1）。
 * 13 = 字段写权逐项（P1-1）；14 = 人员对象“看全部”范围（P1-2）；15 = 命令内 exitImportGuard 的撤权竞态（P2-4）。
 * 竞态用可控屏障模拟：入口授权器调用放行并记下“入口已过”，之后（armed）命令事务内的授权 / 范围才收窄。
 */
import './support/exit-gate-enforced.js';
import { bootstrapTenantAdmin, type Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { H, importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { isButton, orgScope, type Request } from './support/revocable-rights.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BUTTON = 'Employment.DimissionImport';
const EMPLOYEE = MODULE_OBJECTS.employee.code;
const RECORD = MODULE_OBJECTS.employmentRecord.code;
const FIELDS = [
  ...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code),
  ...MODULE_OBJECTS.employee.fields.map((field) => field.code),
  'id',
  'revision',
];
const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };

/** 一行把所有可选字段都用上：字典三项、加黑三项（逐项撤权时每一项都在本批实际写入的字段里）。 */
const fullRow = (x: ImportWorld, deptCode: string, n = 1) =>
  x.row(n, deptCode, {
    exitReasonCode: 'personal',
    exitDestinationCode: 'startup',
    addToBlacklist: true,
    blacklistReason: 'instability',
    blacklistExpiryDate: '2030-01-01',
    blacklistNote: '合成备注',
  });

const key = () => ({ idempotencyKey: `dm30-${uniqueSuffix()}` });

/** preview 与 import 都 403，且不带逐行结果（否则工号存在性可被探测）。 */
async function expectDenied(call: Caller, rows: ReturnType<typeof fullRow>[]) {
  for (const path of ['/exits/import/preview', '/exits/import']) {
    const response = await call(path, { body: { rows }, ...key() });
    expect(response.status, `${path} ${await response.clone().text()}`).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('EMPLOYEE_NO_EXISTS');
  }
}

type Caller = (path: string, init?: Record<string, unknown>) => Promise<Response>;

interface Rights {
  /** 命令事务内才应用下面的收窄（入口已过之后）。 */
  armed: boolean;
  denyInTx?: (request: Request) => boolean;
  /** 入口与事务内都生效的人员对象范围。 */
  employeeScope?: ModuleScope;
  /** 仅命令事务内的人员对象范围。 */
  txEmployeeScope?: ModuleScope;
}

/**
 * 可控屏障授权器：入口（无事务）授权器调用一律放行并记下“入口按钮复核已过”；
 * 事务内（命令守卫 / 事务内解析的范围）在 armed 且入口已过之后应用 rights。
 */
function gated(x: ImportWorld) {
  const rights: Rights = { armed: false };
  let entryPassed = false;
  const authorize: Authorizer = (request) => {
    if (isButton(BUTTON)(request)) entryPassed = true;
    return true;
  };
  const request = x.restricted(authorize, undefined, FIELDS);
  const late = () => rights.armed && entryPassed;
  registerScopeProvider(authorize, {
    scope: async (query, tx) => {
      if (query.objectCode !== EMPLOYEE) return ALL;
      if (tx && late() && rights.txEmployeeScope) return rights.txEmployeeScope;
      return rights.employeeScope ?? ALL;
    },
    authorize: async (req, tx) => !(tx && late() && rights.denyInTx?.(req)),
    fields: async () => new Set(FIELDS),
  });
  const call: Caller = (path, init = {}) => {
    entryPassed = false;
    return request('POST', path, init);
  };
  return { call, rights };
}

describe('AC-DM-30-13 字段写权逐项（P1-1）', () => {
  const fieldCases = [
    'lastWorkDate',
    'exitTypeCode',
    'reasonCode',
    'whereaboutsCode',
    'addToBlacklist',
    'blacklistReason',
    'blacklistExpiryDate',
    'blacklistNote',
  ] as const;

  it.each(fieldCases)('撤掉 %s 的创建写权：preview 与 import 都 403，零写入', async (field) => {
    const x = await importWorld(database().db, `13-${field}`);
    const d = await x.dept('字段权部门');
    const authorize: Authorizer = (request) =>
      !(request.action === 'object.create' && request.resource === RECORD && (request.fields ?? []).includes(field));
    const before = await x.writeCounts();
    const request = x.restricted(authorize, undefined, FIELDS);
    await expectDenied((path, init) => request('POST', path, init), [fullRow(x, d.code)]);
    expect(await x.writeCounts()).toEqual(before);
  });

  it('对照：全部字段写权都在时同一行可以导入', async () => {
    const x = await importWorld(database().db, '13-control');
    const d = await x.dept('字段权对照部门');
    const request = x.restricted(() => true, undefined, FIELDS);
    const response = await request('POST', '/exits/import', { body: { rows: [fullRow(x, d.code)] }, ...key() });
    expect(response.status, await response.clone().text()).toBe(201);
  });

  it('第一次成功后撤掉 reasonCode 写权：同键重放 403，不回放旧回执', async () => {
    const x = await importWorld(database().db, '13-replay');
    const d = await x.dept('字段权重放部门');
    let revoked = false;
    const authorize: Authorizer = (request) =>
      !(revoked && request.action === 'object.create' && (request.fields ?? []).includes('reasonCode'));
    const request = x.restricted(authorize, undefined, FIELDS);
    const options = { body: { rows: [fullRow(x, d.code)] }, ...key() };
    expect((await request('POST', '/exits/import', options)).status).toBe(201);
    revoked = true;
    expect((await request('POST', '/exits/import', options)).status).toBe(403);
  });

  it('入口放行之后、命令事务内撤掉 whereaboutsCode 写权：命令守卫拒绝，零写入', async () => {
    const x = await importWorld(database().db, '13-guard');
    const d = await x.dept('字段权竞态部门');
    const { call, rights } = gated(x);
    rights.armed = true;
    rights.denyInTx = (request) =>
      request.action === 'object.create' && (request.fields ?? []).includes('whereaboutsCode');
    const before = await x.writeCounts();
    const response = await call('/exits/import', { body: { rows: [fullRow(x, d.code)] }, ...key() });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await x.writeCounts()).toEqual(before);
  });
});

describe('AC-DM-30-14 人员对象看全部范围（P1-2）', () => {
  it('任职记录看全部、人员对象只有部门范围：preview 与 import 都 403，零写入（与 POST /employees 同口径）', async () => {
    const x = await importWorld(database().db, '14-partial');
    const d = await x.dept('人员范围部门');
    const { call, rights } = gated(x);
    rights.employeeScope = orgScope(x.tenantId, H, d.id);
    const before = await x.writeCounts();
    await expectDenied(call, [fullRow(x, d.code)]);
    expect(await x.writeCounts()).toEqual(before);
  });

  it('第一次成功后，人员对象看全部在入口放行后被撤：同键重放 403，不回放旧回执', async () => {
    const x = await importWorld(database().db, '14-replay');
    const d = await x.dept('人员范围重放部门');
    const { call, rights } = gated(x);
    const options = { body: { rows: [fullRow(x, d.code)] }, ...key() };
    expect((await call('/exits/import', options)).status).toBe(201);
    rights.armed = true;
    rights.txEmployeeScope = orgScope(x.tenantId, H, d.id);
    const replay = await call('/exits/import', options);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await x.employeeCount()).toBe(1);
  });

  it('真实授权配置：只配了任职记录“看全部”的身份 403；再配上人员对象“看全部”后同一请求 201', async () => {
    const x = await importWorld(database().db, '14-real');
    const d = await x.dept('真实配置部门');
    const { tenant, user } = x.session;
    const pw = {
      db: x.db,
      tenant,
      admin: user,
      adminRecord: await bootstrapTenantAdmin(x.db, { tenantId: tenant.id, userId: user.id }, cmd()),
      api: tenantApi(x.db, { authorize: undefined, clock: () => new Date('2026-11-05T01:00:00Z') }),
      asAdmin: { user: user.id, tenant: tenant.id },
    };
    const profile = await createProfile(pw, `imp-${uniqueSuffix()}`, { apps: ['TenantBase'] });
    for (const definition of Object.values(MODULE_OBJECTS)) {
      const response = await setObjectPermission(
        pw,
        profile,
        {
          dataOperations: { create: true, update: true, delete: true },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
          buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        definition.code,
      );
      expect(response.status, `${definition.code} ${await response.clone().text()}`).toBe(200);
    }
    const seeAll = async (target: string, value: boolean, ifMatch: number) => {
      const response = await pw.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
        {
          ...pw.asAdmin,
          ifMatch,
          body: { targetKind: 'entity', targetCode: target, seeAll: value },
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await seeAll(RECORD, true, 0);
    await makeGrantable(pw, [profile.id]);
    const operator = await addMember(pw, `imp-op-${uniqueSuffix()}`);
    expect((await grant(pw, operator.id, profile.id)).status).toBe(201);
    const call = (path: string) =>
      pw.api.request('POST', `/api/tenant/employment${path}`, {
        user: operator.id,
        tenant: tenant.id,
        body: { rows: [x.row(1, d.code)] },
        ...key(),
      });
    const before = await x.writeCounts();
    for (const path of ['/exits/import/preview', '/exits/import']) expect((await call(path)).status, path).toBe(403);
    expect(await x.writeCounts()).toEqual(before);
    await seeAll(EMPLOYEE, true, 0);
    const preview = await call('/exits/import/preview');
    expect(preview.status, await preview.clone().text()).toBe(200);
    const imported = await call('/exits/import');
    expect(imported.status, await imported.clone().text()).toBe(201);
  });
});

describe('AC-DM-30-15 命令内 exitImportGuard 的撤权竞态（P2-4）', () => {
  it('入口按钮复核通过后、命令执行前撤掉导入按钮：命令守卫拒绝 403，零写入，无审计', async () => {
    const x = await importWorld(database().db, '15-first');
    const d = await x.dept('竞态部门');
    const { call, rights } = gated(x);
    rights.armed = true;
    rights.denyInTx = isButton(BUTTON);
    const before = await x.writeCounts();
    const audits = await x.auditCount('employment.exit.imported');
    const response = await call('/exits/import', { body: { rows: [x.row(1, d.code)] }, ...key() });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await x.writeCounts()).toEqual(before);
    expect(await x.auditCount('employment.exit.imported')).toBe(audits);
  });

  it('第一次成功后，入口放行但命令内按钮被撤：同键重放 403，不回放旧回执', async () => {
    const x = await importWorld(database().db, '15-replay');
    const d = await x.dept('竞态重放部门');
    const { call, rights } = gated(x);
    const options = { body: { rows: [x.row(1, d.code)] }, ...key() };
    expect((await call('/exits/import', options)).status).toBe(201);
    rights.armed = true;
    rights.denyInTx = isButton(BUTTON);
    const replay = await call('/exits/import', options);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await x.employeeCount()).toBe(1);
  });
});
