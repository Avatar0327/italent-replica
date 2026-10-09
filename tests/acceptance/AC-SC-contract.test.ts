/**
 * R3-T05 契约 PR（设计 §12 第 2 项、§13）：共享文件先合，PR-A～PR-D 只改本模块目录。
 * - 对象目录与应用登记（§8.1；DEC-043 / 080）、标准身份 3 个（数据范围默认空，规则配置对象按 DEC-121 预置看全部）；
 * - 审计中文名与审计查看规则登记位（§8.4；DEC-197 / 216）；
 * - 租户开关种子与写入校验（§1.5）；
 * - 任职状态钩子端口（§5.4；DEC-343：离职事件同事务通知订阅方，不补发）；
 * - 健康度计算端口的实现登记位（SP-15）与继任定时任务登记位（§4.6）。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, sql, withTenant, type Tx } from '@italent/db';
import {
  auditObjectMeta,
  EMPLOYEE_STATUS,
  RULE_OPERATORS,
  SUCCESSION_APP,
  SUCCESSION_CONFIG_OBJECTS,
  SUCCESSION_OBJECTS,
  SUCCESSION_SETTING_KEYS,
  SUCCESSION_SETTINGS,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { auditObjectRegistered } from '../../apps/api/src/audit/visibility.js';
import {
  type EmploymentRecordEvent,
  registerEmployeeStatusHooks,
  resetEmployeeStatusHooksForTest,
} from '../../apps/api/src/modules/employment/status-hooks.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { scopeAppOf } from '../../apps/api/src/modules/permission/module-access.js';
import { installSuccessionPorts } from '../../apps/api/src/modules/succession/ports.js';
import { startSuccessionScheduler, type SuccessionJob } from '../../apps/api/src/modules/succession/scheduler.js';
import {
  orgHealthComputePort,
  resetOrgHealthComputePortForTest,
  type OrgHealthComputePort,
} from '../../apps/api/src/modules/talent-review/health-port.js';
import { auditApi } from './AC-AUD-support.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import {
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';
import { errorCode, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const O = SUCCESSION_OBJECTS;

describe('对象目录与应用登记（§8.1；DEC-043 / DEC-080）', () => {
  it('十个对象都登记在 SuccessionAndDevelopment，装配后权限目录可解析，数据范围按该应用解析', () => {
    tenantApi(testDb().db);
    expect(Object.keys(O)).toHaveLength(10);
    for (const definition of Object.values(O)) {
      expect(definition.code.startsWith('Succession.'), definition.code).toBe(true);
      expect(objectCatalog.get(definition.code)?.application).toBe(SUCCESSION_APP);
      expect(scopeAppOf(definition.code)).toBe(SUCCESSION_APP);
    }
  });

  it('按钮、级别与依赖的数据操作照设计；派生与可信系统值是系统字段，不可授编辑', () => {
    const buttons = (code: keyof typeof O) => O[code].buttons.map((b) => [b.code, b.level, b.requires ?? null]);
    expect(buttons('record')).toEqual([
      ['create', 'list', 'create'],
      ['update', 'detail', 'update'],
      ['delete', 'detail', 'delete'],
      ['end', 'list', 'update'],
    ]);
    expect(buttons('map')).toEqual([
      ['computeRisk', 'list', null],
      ['computeHealth', 'list', null],
      ['computeStats', 'list', null],
    ]);
    expect(buttons('riskResult')).toEqual([['assign', 'detail', 'update']]);
    expect(buttons('healthResult')).toEqual([
      ['assign', 'detail', 'update'],
      ['reset', 'list', 'update'],
    ]);
    for (const level of ['riskLevel', 'healthLevel', 'population'] as const)
      expect(buttons(level).map(([code]) => code)).toEqual(['create', 'update', 'delete', 'reorder']);
    expect(buttons('calcRun')).toEqual([['retry', 'detail', 'update']]);
    expect(buttons('syncBatch')).toEqual([
      ['sync', 'list', 'create'],
      ['retry', 'detail', 'update'],
      ['abort', 'detail', 'update'],
    ]);
    const editable = (code: keyof typeof O) => O[code].fields.filter((f) => !f.system).map((f) => f.code);
    expect(editable('record')).toEqual([
      'successionType',
      'targetOrgId',
      'targetPositionId',
      'successorEmployeeId',
      'readinessId',
      'backupType',
      'startDate',
      'endDate',
      'endReason',
    ]);
    expect(editable('riskResult')).toEqual(['levelId']);
    expect(editable('healthResult')).toEqual(['levelId']);
    expect(editable('calcRun')).toEqual([]);
    expect(editable('syncBatch')).toEqual([]);
    expect(editable('map')).toEqual([]);
    const system = new Set(O.record.fields.filter((f) => f.system).map((f) => f.code));
    for (const field of ['endSource', 'sourceKind', 'status', 'incumbents', 'personInCharge'])
      expect(system.has(field), field).toBe(true);
    expect(SUCCESSION_CONFIG_OBJECTS).toEqual(['riskLevel', 'healthLevel', 'population', 'ruleSettings']);
  });

  it('条件行运算符与设计 §3.1 一致（T05 / T06 共用契约）', () => {
    expect(RULE_OPERATORS).toEqual(['is_empty', 'not_empty', 'eq', 'ne', 'gt', 'lt', 'ge', 'le', 'between']);
  });
});

describe('标准身份（§8.1；硬规则：数据范围默认空；DEC-121）', () => {
  async function presets() {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const admin = await newUser(db, 'sc-preset-admin');
    const result = await provisioned(api, await seedOperator(db), {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: admin.id,
    });
    const as = { user: admin.id, tenant: result.tenant.id };
    const detail = async (code: string) => {
      const preset = result.profiles.find((profile) => profile.code === code)!;
      expect(preset, code).toBeDefined();
      const response = await api.request('GET', `${BASE}/profiles/${preset.id}`, as);
      const body = (await response.json()) as {
        apps: string[];
        licenseType: string | null;
        objects: {
          objectCode: string;
          dataOperations: Record<string, boolean>;
          buttons: { buttonCode: string }[];
        }[];
      };
      const seeAll = async (objectCode: string) => {
        const path = `${BASE}/profiles/${preset.id}/data-scopes/${SUCCESSION_APP}?targetKind=entity&targetCode=`;
        return ((await (await api.request('GET', `${path}${objectCode}`, as)).json()) as { seeAll: boolean }).seeAll;
      };
      const objects = new Map(body.objects.map((object) => [object.objectCode, object]));
      return { body, objects, seeAll, name: preset.name };
    };
    return { detail };
  }
  const buttonsOf = (object: { buttons: { buttonCode: string }[] } | undefined) =>
    (object?.buttons ?? []).map((b) => b.buttonCode).sort();

  it('继任管理员：只带本应用，全部对象全部功能；只对四个规则配置对象预置看全部', async () => {
    const { detail } = await presets();
    const admin = await detail('standard_succession_admin');
    expect(admin.name).toBe('继任管理员（继任与发展）');
    expect(admin.body.apps).toEqual([SUCCESSION_APP]);
    expect(admin.body.licenseType).toBeNull();
    expect([...admin.objects.keys()].sort()).toEqual(
      Object.values(O)
        .map((d) => d.code)
        .sort(),
    );
    for (const definition of Object.values(O)) {
      expect(admin.objects.get(definition.code)?.dataOperations).toEqual({ create: true, update: true, delete: true });
      expect(buttonsOf(admin.objects.get(definition.code))).toEqual(definition.buttons.map((b) => b.code).sort());
      const config = SUCCESSION_CONFIG_OBJECTS.some((key) => O[key].code === definition.code);
      expect(await admin.seeAll(definition.code), definition.code).toBe(config);
    }
  });

  it('继任 HR：记录 / 地图 / 结果 / 任务，不含规则配置；批次没有终止按钮；不预置看全部', async () => {
    const { detail } = await presets();
    const hr = await detail('standard_succession_hr');
    expect(hr.body.apps).toEqual([SUCCESSION_APP]);
    const codes = ['record', 'map', 'riskResult', 'healthResult', 'calcRun', 'syncBatch'] as const;
    expect([...hr.objects.keys()].sort()).toEqual(codes.map((key) => O[key].code).sort());
    expect(buttonsOf(hr.objects.get(O.syncBatch.code))).toEqual(['retry', 'sync']);
    expect(buttonsOf(hr.objects.get(O.record.code))).toEqual(['create', 'delete', 'end', 'update']);
    for (const key of codes) expect(await hr.seeAll(O[key].code), key).toBe(false);
  });

  it('继任计算主体：记录增删改、结果赋值 / 重置、地图三个计算按钮；不预置看全部', async () => {
    const { detail } = await presets();
    const runner = await detail('standard_succession_runner');
    expect(runner.body.apps).toEqual([SUCCESSION_APP]);
    expect([...runner.objects.keys()].sort()).toEqual(
      [O.record.code, O.riskResult.code, O.healthResult.code, O.map.code].sort(),
    );
    expect(buttonsOf(runner.objects.get(O.record.code))).toEqual(['create', 'delete', 'update']);
    expect(buttonsOf(runner.objects.get(O.riskResult.code))).toEqual(['assign']);
    expect(buttonsOf(runner.objects.get(O.healthResult.code))).toEqual(['assign', 'reset']);
    expect(runner.objects.get(O.healthResult.code)?.dataOperations).toEqual({
      create: false,
      update: true,
      delete: false,
    });
    expect(buttonsOf(runner.objects.get(O.map.code))).toEqual(['computeHealth', 'computeRisk', 'computeStats']);
    for (const code of runner.objects.keys()) expect(await runner.seeAll(code), code).toBe(false);
  });
});

describe('审计（§8.4；DEC-197 / 216）', () => {
  it('审计日志按领域目录显示对象中文名与应用“继任与发展”', () => {
    expect(auditObjectMeta(O.record.code)).toEqual({ label: '继任记录', app: '继任与发展' });
    expect(auditObjectMeta(O.healthResult.code)).toEqual({ label: '组织健康度结果', app: '继任与发展' });
    for (const definition of Object.values(O)) expect(auditObjectMeta(definition.code).app).toBe('继任与发展');
  });

  it('会写审计的对象类型都已登记查看规则；不写审计的地图不登记（fail-closed）', () => {
    for (const key of Object.keys(O) as (keyof typeof O)[])
      expect(auditObjectRegistered(O[key].code), key).toBe(key !== 'map');
  });

  async function auditWorld() {
    const db = testDb().db;
    const world: PermissionWorld = await seedPermissionWorld(db);
    const events = [
      [O.riskLevel.code, 'succession.risk-level.create', null],
      [O.healthResult.code, 'succession.health-result.update', world.tenant.id],
      [O.record.code, 'succession.record.create', world.tenant.id],
      [O.calcRun.code, 'succession.calc-run.create', null],
    ] as const;
    await withTenant(db, world.tenant.id, async (tx) => {
      for (const [objectType, action, orgId] of events)
        await insertAuditEvent(tx, {
          tenantId: world.tenant.id,
          actorUserId: world.admin.id,
          action,
          objectType,
          objectId: randomUUID(),
          before: null,
          after: { name: '合成名称', levelId: randomUUID() },
          commandId: randomUUID(),
          ...(orgId ? { scope: { orgId } } : {}),
        });
    });
    return world;
  }

  async function viewer(world: PermissionWorld, seeAll: readonly string[]) {
    const user = await memberWithAdminRole(world, 'audit_admin', `sc-audit-${randomUUID().slice(0, 6)}`);
    const profile = await createProfile(world, `sc-audit-${randomUUID().slice(0, 6)}`, { apps: [SUCCESSION_APP] });
    for (const definition of [O.riskLevel, O.healthResult, O.record, O.calcRun]) {
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
          buttons: [],
        },
        definition.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.user.id, profile.id)).status).toBe(201);
    // “看全部”按（身份 × 应用 × 对象）各存一份，各自从 revision 0 起
    for (const code of seeAll) {
      const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${SUCCESSION_APP}`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: code, seeAll: true },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    return user.as;
  }

  it('规则配置只认看全部；组织锚点按范围；记录日志由 A1 的 SELF 谓词裁剪（见 AC-SC-self），任务日志等逐行谓词随 B3 / D3 提供前一律不返回', async () => {
    const world = await auditWorld();
    const audit = auditApi(world.db, () => new Date(), { authorize: undefined });
    const visibleTypes = async (as: { user: string; tenant: string }) => {
      const types: string[] = [];
      for (const objectType of [O.riskLevel.code, O.healthResult.code, O.record.code, O.calcRun.code]) {
        const { items } = await audit.dataChanges(as, { objectType, limit: '50' });
        if (items.length) types.push(objectType);
      }
      return types;
    };
    const all = await viewer(world, [O.riskLevel.code, O.healthResult.code, O.record.code, O.calcRun.code]);
    expect(await visibleTypes(all)).toEqual([O.riskLevel.code, O.healthResult.code, O.record.code]);
    // 有对象查看权、数据范围默认空：规则配置与组织锚点对象都看不到
    expect(await visibleTypes(await viewer(world, []))).toEqual([]);
  });
});

describe('租户开关（§1.5；DEC-311 D-04 / DEC-194）', () => {
  const settingPath = (key: string) => `/api/tenant/settings/${key}`;

  it('种子系统值与领域默认值、说明逐键一致；租户未覆盖时来源为 system', async () => {
    const { db } = testDb();
    const { tenant, user } = await seedTenantWithMember(db, 'sc-settings');
    const api = tenantApi(db);
    const rows = await db.execute(
      sql`SELECT key, value, description, overridable FROM system_settings WHERE key LIKE 'succession.%' ORDER BY key`,
    );
    const seeded = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as {
      key: string;
      value: unknown;
      description: string;
      overridable: boolean;
    }[];
    expect(seeded.map((row) => row.key)).toEqual([...SUCCESSION_SETTING_KEYS].sort());
    for (const row of seeded) {
      // system_settings.value 非空：JSON null 在租户备份恢复按记录集写回时会变成 SQL NULL（AC-TEN-06）
      expect(row.value, row.key).not.toBeNull();
      const spec = SUCCESSION_SETTINGS[row.key as keyof typeof SUCCESSION_SETTINGS];
      expect(row, row.key).toEqual({
        key: row.key,
        value: spec.defaultValue,
        description: spec.description,
        overridable: true,
      });
      const response = await api.request('GET', settingPath(row.key), { user: user.id, tenant: tenant.id });
      expect(await response.json()).toMatchObject({ value: spec.defaultValue, source: 'system', revision: 0 });
    }
  });

  it('非法值 400 SETTING_VALUE_INVALID 且不写覆盖；合法值照常覆盖', async () => {
    const { db } = testDb();
    const { tenant, user } = await seedTenantWithMember(db, 'sc-settings-invalid');
    const api = tenantApi(db);
    const as = { user: user.id, tenant: tenant.id };
    const invalid: [string, unknown][] = [
      ['succession.self_successors_visible', 'true'],
      ['succession.sync_strategy', 'replace'],
      ['succession.part_time_in_risk_calc', 1],
      ['succession.map_default_depth', 5],
      ['succession.map_default_depth', 2.5],
      ['succession.org_stats_interval_hours', 0],
      ['succession.system_principal_user_id', randomUUID().toUpperCase()],
      ['succession.system_principal_user_id', 'not-a-user'],
    ];
    for (const [key, value] of invalid) {
      const response = await api.request('PUT', settingPath(key), { ...as, ifMatch: 0, body: { value } });
      expect(response.status, `${key}=${JSON.stringify(value)}`).toBe(400);
      expect(await errorCode(response)).toBe('VALIDATION_FAILED');
      const after = await api.request('GET', settingPath(key), as);
      expect(await after.json()).toMatchObject({ source: 'system', revision: 0 });
    }
    const valid: [string, unknown][] = [
      ['succession.self_successors_visible', false],
      ['succession.sync_strategy', 'overwrite_in_scope'],
      ['succession.part_time_in_risk_calc', true],
      ['succession.map_default_depth', 4],
      ['succession.org_stats_interval_hours', 24],
      ['succession.system_principal_user_id', randomUUID()],
    ];
    for (const [key, value] of valid) {
      const response = await api.request('PUT', settingPath(key), { ...as, ifMatch: 0, body: { value } });
      expect(response.status, key).toBe(200);
      expect(await response.json()).toMatchObject({ value, source: 'tenant', revision: 1 });
    }
  });
});

describe('任职状态钩子端口（§5.4；DEC-343）', () => {
  afterEach(() => resetEmployeeStatusHooksForTest());

  interface Seen {
    readonly hook: 'materialized' | 'deleted';
    readonly event: EmploymentRecordEvent;
    readonly persisted: boolean;
  }

  /** 订阅方在同一事务里能读到刚写入 / 已删除的记录，证明调用发生在任职写入的事务内。 */
  function recorder(seen: Seen[]) {
    const persisted = async (tx: Tx, event: EmploymentRecordEvent) => {
      const result = await tx.execute(
        sql`SELECT 1 FROM employment_timeline WHERE employee_id = ${event.employeeId}::uuid
          AND record_id = ${event.recordId}::uuid`,
      );
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows).length > 0;
    };
    return {
      async onRecordMaterialized(tx: Tx, _ctx: unknown, event: EmploymentRecordEvent) {
        seen.push({ hook: 'materialized', event, persisted: await persisted(tx, event) });
      },
      async onRecordDeleted(tx: Tx, _ctx: unknown, event: EmploymentRecordEvent) {
        seen.push({ hook: 'deleted', event, persisted: await persisted(tx, event) });
      },
    };
  }

  async function hired(session: EmploymentSession) {
    const employee = await session.employee();
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { employType: 'internal' } },
      employee.revision,
    );
    return { employee, hire };
  }

  it('直接离职（生效日已到 / 未来）同事务通知：离职生效日 = 最后工作日次日，人员状态 = 离职', async () => {
    const seen: Seen[] = [];
    registerEmployeeStatusHooks('test-recorder', recorder(seen));
    const session = await employmentSession(testDb().db, 'sc-hook-exit');
    const { employee, hire } = await hired(session);
    expect(seen).toEqual([
      {
        hook: 'materialized',
        persisted: true,
        event: expect.objectContaining({ employeeId: employee.id, recordId: hire.id, kind: 'hire' }),
      },
    ]);
    expect(seen[0]!.event.employeeStatus).not.toBe(EMPLOYEE_STATUS.left);
    const leave = await session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      hire.employeeRevision,
    );
    expect(seen[1]).toEqual({
      hook: 'materialized',
      persisted: true,
      event: {
        employeeId: employee.id,
        recordId: leave.id,
        kind: 'leave',
        effectiveDate: '2026-10-01',
        lastWorkDate: '2026-09-30',
        employeeStatus: EMPLOYEE_STATUS.left,
      },
    });

    const other = await hired(session);
    await session.business(
      other.employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-11-30' },
      other.hire.employeeRevision,
    );
    // 未来离职保存即落地：事件在保存时发出，生效日在未来，由订阅方的夜间任务按生效日处理（DEC-343①）
    expect(seen.at(-1)?.event).toMatchObject({
      employeeId: other.employee.id,
      kind: 'leave',
      effectiveDate: '2026-12-01',
      employeeStatus: EMPLOYEE_STATUS.left,
    });
  });

  it('删除已生效的离职记录：同事务通知被删除的那条记录', async () => {
    const seen: Seen[] = [];
    const session = await employmentSession(testDb().db, 'sc-hook-delete');
    const { employee, hire } = await hired(session);
    const leave = await session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      hire.employeeRevision,
    );
    registerEmployeeStatusHooks('test-recorder', recorder(seen));
    const current = (await (await session.request('GET', `/businesses/${leave.id}`)).json()) as { revision: number };
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      transitionEmployment(
        tx,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          timezone: session.tenant.timezone,
          now: new Date('2026-10-01T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: current.revision,
        },
        { id: leave.id, action: 'delete' },
      ),
    );
    expect(seen).toEqual([
      {
        hook: 'deleted',
        persisted: false,
        event: {
          employeeId: employee.id,
          recordId: leave.id,
          kind: 'leave',
          effectiveDate: '2026-10-01',
          lastWorkDate: '2026-09-30',
          employeeStatus: EMPLOYEE_STATUS.left,
        },
      },
    ]);
  });

  it('订阅方抛错 → 整个任职写入回滚；多个订阅方按名称顺序调用；同名另一实现拒绝登记', async () => {
    const order: string[] = [];
    const named = (name: string) => ({
      async onRecordMaterialized() {
        order.push(name);
      },
    });
    const b = named('b-pool');
    registerEmployeeStatusHooks('b-pool', b);
    registerEmployeeStatusHooks('a-succession', named('a-succession'));
    registerEmployeeStatusHooks('b-pool', b);
    expect(() => registerEmployeeStatusHooks('b-pool', named('b-pool'))).toThrow();
    const session = await employmentSession(testDb().db, 'sc-hook-order');
    const { employee, hire } = await hired(session);
    expect(order).toEqual(['a-succession', 'b-pool']);

    registerEmployeeStatusHooks('c-broken', {
      async onRecordMaterialized(_tx, _ctx, event) {
        if (event.kind === 'leave') throw new Error('订阅方存储不可用');
      },
    });
    const before = await session.records(employee.id, '2026-10-01');
    const response = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await session.records(employee.id, '2026-10-01')).toEqual(before);
    expect((await session.getEmployee(employee.id)).revision).toBe(hire.employeeRevision);
  });
});

describe('对外端口与定时任务登记位（SP-15 / DEC-330、§4.6 / DEC-343）', () => {
  afterEach(() => resetOrgHealthComputePortForTest());

  it('契约 PR 不登记健康度实现（T04 仍 400）；装配位登记的实现可重复安装', () => {
    resetOrgHealthComputePortForTest();
    tenantApi(testDb().db);
    installSuccessionPorts();
    expect(orgHealthComputePort()).toBeNull();
    const port: OrgHealthComputePort = { compute: async () => [], listLevels: async () => [] };
    installSuccessionPorts({ orgHealthCompute: port });
    installSuccessionPorts({ orgHealthCompute: port });
    expect(orgHealthComputePort()).toBe(port);
    expect(() => installSuccessionPorts({ orgHealthCompute: { ...port } })).toThrow();
  });

  it('没有任务时不起定时器；有任务时串行触发，一个失败只上报、不影响其他任务', async () => {
    const { db } = testDb();
    const idle = startSuccessionScheduler(db);
    await idle.stop();
    const ran: string[] = [];
    const errors: string[] = [];
    const jobs: SuccessionJob[] = [
      {
        kind: 'exit_sweep',
        run: async () => {
          ran.push('exit_sweep');
          throw new Error('合成失败');
        },
      },
      { kind: 'position_risk', run: async () => void ran.push('position_risk') },
    ];
    const scheduler = startSuccessionScheduler(db, {
      jobs,
      intervalMs: 3_600_000,
      onError: (kind) => errors.push(kind),
    });
    await scheduler.stop();
    expect(ran).toEqual(['exit_sweep', 'position_risk']);
    expect(errors).toEqual(['exit_sweep']);
  });
});
