/**
 * AC-DM-30-07～10：历史离职导入不触发生效副作用、黑名单、权限链与幂等（F-139a，设计 §5～§7）。
 */
import './support/exit-gate-enforced.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { E, H, importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BUTTON = 'Employment.DimissionImport';
const FIELDS = [
  ...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code),
  ...MODULE_OBJECTS.employee.fields.map((field) => field.code),
  'id',
  'revision',
];

describe('AC-DM-30-07 不触发生效副作用', () => {
  it('探针 onEffective 0 次；在职员工的在途调动不受影响；无 exit_effects / 账号停用任务', async () => {
    const x = await importWorld(database().db, '07');
    const calls: string[] = [];
    exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => void calls.push(event.businessId));
    const d = await x.dept('副作用部门');
    const onJob = await x.hired('在职对照');
    const transfer = await x.applyAs(x.session.user.id, onJob.employee.id, '2026-12-01', { departmentId: x.to.id });
    const before = await x.stateOf(onJob.employee.id);
    const body = await x.created([x.row(1, d.code), x.row(2, d.code)]);
    expect(calls).toEqual([]);
    expect(await x.stateOf(onJob.employee.id)).toEqual(before);
    expect((await x.businessesOf(onJob.employee.id)).find((b) => b.id === transfer.id)?.state).toBe('in_review');
    for (const item of body.rows) {
      const counts = await x.q<{ n: string }>(x.sql`SELECT
        (SELECT count(*) FROM exit_effects WHERE tenant_id=${x.tenantId} AND business_id=${item.exitBusinessId}::uuid)
        + (SELECT count(*) FROM employment_activation_attempts WHERE tenant_id=${x.tenantId}
            AND business_id=${item.exitBusinessId}::uuid) AS n`);
      expect(Number(counts[0]!.n)).toBe(0);
    }
  });
});

describe('AC-DM-30-08 加黑只认手动勾选', () => {
  it('勾选行写手动名单（日期 = E、source = manual、关联离职单）；未勾选行不被自动规则加黑', async () => {
    const x = await importWorld(database().db, '08');
    const d = await x.dept('加黑部门');
    const settings = '/api/tenant/settings/exit.auto_blacklist_enabled';
    const as = { tenant: x.tenantId, user: x.session.user.id };
    const api = tenantApi(x.db, { clock: () => new Date('2026-11-05T01:00:00Z') });
    const current = await api.request('GET', settings, as);
    const turnOn = await api.request('PUT', settings, {
      ...as,
      ifMatch: ((await current.json()) as { revision: number }).revision,
      body: { value: true },
    });
    expect(turnOn.status, await turnOn.clone().text()).toBe(200);
    const rule = await x.session.request('POST', '/blacklist-rules', {
      ifMatch: 0,
      body: {
        name: `规则-${uniqueSuffix()}`,
        priority: 1,
        orgIds: [d.id],
        conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }],
        term: 'permanent',
        reason: 'instability',
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const body = await x.created([
      x.row(1, d.code, { addToBlacklist: true, blacklistReason: 'instability', blacklistExpiryDate: '2030-01-01' }),
      x.row(2, d.code),
    ]);
    const listing = (employeeId: string) =>
      x.q<{ blacklistDate: string; source: string; exitRequestId: string; expiryDate: string }>(x.sql`
        SELECT blacklist_date::text AS "blacklistDate", source, exit_request_id::text AS "exitRequestId",
          expiry_date::text AS "expiryDate" FROM employment_blacklist
        WHERE tenant_id=${x.tenantId} AND employee_id=${employeeId}::uuid`);
    expect(await listing(body.rows[0]!.employeeId)).toEqual([
      { blacklistDate: E, source: 'manual', exitRequestId: body.rows[0]!.exitBusinessId, expiryDate: '2030-01-01' },
    ]);
    expect(await listing(body.rows[1]!.employeeId)).toEqual([]);
  });
});

/** 范围只是某个部门（不是显式看全部）的 scope。 */
function orgScope(tenantId: string, orgId: string): ModuleScope {
  return {
    ...EMPTY_SCOPE,
    hasDataPermission: true,
    terms: [
      {
        dimension: 'organization',
        orgIds: [orgId],
        personIds: [],
        personQuery: { kind: 'organization', tenantId, asOf: H },
      },
    ],
  };
}

async function denied(x: ImportWorld, request: ReturnType<ImportWorld['restricted']>, rows = [x.row(1, 'NOPE')]) {
  for (const path of ['/exits/import/preview', '/exits/import']) {
    const response = await request('POST', path, { body: { rows } });
    expect(response.status, path).toBe(403);
    // preview 的 403 不带逐行结果，否则工号存在性可被探测
    expect(JSON.stringify(await response.json())).not.toContain('EMPLOYEE_NO_EXISTS');
  }
}

describe('AC-DM-30-09 权限链', () => {
  it('① 没有 Employment.DimissionImport：preview 与 import 都 403', async () => {
    const x = await importWorld(database().db, '09-1');
    const d = await x.dept('权限部门');
    await x.created([x.row(1, d.code, { employeeNo: 'H0900' })]);
    await denied(x, x.restricted(denyButtons(BUTTON), undefined, FIELDS), [x.row(1, d.code, { employeeNo: 'H0900' })]);
  });

  it('② 有按钮但数据范围只是部门范围：403', async () => {
    const x = await importWorld(database().db, '09-2');
    const d = await x.dept('范围部门');
    const authorize = () => true;
    // restricted() 会按同一 authorize 注册“全部数据”提供者，部门范围必须在它之后注册才生效
    const request = x.restricted(authorize, undefined, FIELDS);
    registerScopeProvider(authorize, {
      scope: async () => orgScope(x.tenantId, d.id),
      authorize: async () => true,
      fields: async () => new Set(FIELDS),
    });
    await denied(x, request, [x.row(1, d.code)]);
  });

  it('③ 缺 EMPLOYEE 的 object.create：403', async () => {
    const x = await importWorld(database().db, '09-3');
    const d = await x.dept('缺创建权部门');
    const authorize = (request: { action: string; resource?: unknown }) =>
      !(request.action === 'object.create' && request.resource === MODULE_OBJECTS.employee.code);
    await denied(x, x.restricted(authorize, undefined, FIELDS), [x.row(1, d.code)]);
  });

  it('④ 第一次成功后撤掉按钮，同键重放得 403，不回放 201', async () => {
    const x = await importWorld(database().db, '09-4');
    const d = await x.dept('撤权部门');
    let revoked = false;
    const authorize = (request: Parameters<ReturnType<typeof denyButtons>>[0]) =>
      revoked ? denyButtons(BUTTON)(request) : true;
    const request = x.restricted(authorize, undefined, FIELDS);
    const options = { body: { rows: [x.row(1, d.code)] }, idempotencyKey: `dm30-${uniqueSuffix()}` };
    const first = await request('POST', '/exits/import', options);
    expect(first.status, await first.clone().text()).toBe(201);
    revoked = true;
    const replay = await request('POST', '/exits/import', options);
    expect(replay.status).toBe(403);
  });
});

describe('AC-DM-30-10 幂等', () => {
  it('同键同内容重放第一次的结果（人员数不变）；同键改一行内容 409 IDEMPOTENCY_CONFLICT 零写入', async () => {
    const x = await importWorld(database().db, '10');
    const d = await x.dept('幂等部门');
    const key = `dm30-${uniqueSuffix()}`;
    const rows = [x.row(1, d.code)];
    const first = await x.importRows(rows, {}, { idempotencyKey: key });
    expect(first.status, await first.clone().text()).toBe(201);
    const firstBody = await first.json();
    const replay = await x.importRows(rows, {}, { idempotencyKey: key });
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    expect(await x.employeeCount()).toBe(1);
    const changed = await x.importRows([x.row(1, d.code, { name: '合成丙' })], {}, { idempotencyKey: key });
    expect(changed.status).toBe(409);
    expect((await x.errorOf(changed)).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await x.employeeCount()).toBe(1);
  });

  it('缺 Idempotency-Key：400 且零写入', async () => {
    const x = await importWorld(database().db, '10b');
    const d = await x.dept('缺键部门');
    const before = await x.writeCounts();
    const response = await x.importRows([x.row(1, d.code)], {}, { idempotencyKey: null });
    expect(response.status).toBe(400);
    expect(await x.writeCounts()).toEqual(before);
  });
});
