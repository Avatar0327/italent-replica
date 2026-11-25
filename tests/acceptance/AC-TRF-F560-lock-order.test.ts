/**
 * AC-TRF-F560（F-560，DEC-993 / 996 / 999 的收尾）：任职写入口统一“员工行 → 业务头 → 封口 → 读授权”的取锁次序。
 * S4 只把调动同单的 PATCH / 提交 / 重放入口改成先取锁再读授权；其余写入口（发起 / 覆盖暂存、联动保存与子项重试、生效重试、
 * 通用新建的编制确认、通用 PATCH / 状态动作作用于非调动单据）仍先在守卫里读授权，等员工行 / 业务头的锁都在读授权之后：
 * 等锁期间管理员收回数据范围，放锁后仍沿用等锁前的旧范围写入。
 *
 * 屏障（真 PG，普通角色 app_owner）：另一事务持有员工行（或业务头）→ 发请求并等它排到锁上 → 收回范围 → 放锁，
 * 请求必须按收回后的授权拒绝（403 / 404），零写入；对照组不收回范围，等完锁后照常成功（修前合法路径仍成功）。
 * 授权用 support/revocable-rights.ts 的可撤权授权器：入口（事务外）放行，事务内才应用 rights，等价于“入口之后被撤权”。
 * 入口清单与改前改后次序见 PR 描述；本文件每个 describe 对应清单里的一个入口。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { linkageWorld, type LinkageWorld } from './AC-LNK-support.js';
import { waitForLockWaiters } from './AC-TRF-F181a-support.js';
import { revocable } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const pg = Boolean(process.env.TEST_DATABASE_URL);
const BASE = '/api/tenant/employment';
const D = '2026-10-10';
/** 失败子项 / 失败生效的夹具在 10-10 跑过定时生效，重试在其后一天。 */
const RETRY_AT = '2026-10-11T02:00:00Z';
const DRAFT_AT = '2026-10-01T01:00:00Z';

type Db = Parameters<typeof withTenant>[0];
type Person = Awaited<ReturnType<LinkageWorld['hire']>>;
const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

/** 另开一个事务持有员工行（或业务头）直到 release，模拟“另一名经办人正在改这名员工 / 这张单”。 */
function holdRow(db: Db, tenantId: string, table: 'employees' | 'heads', id: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const from = table === 'employees' ? sql`employment_employees` : sql`employment_business_objects`;
  const done = withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`SELECT id FROM ${from} WHERE tenant_id=${tenantId} AND id=${id}::uuid FOR UPDATE`);
    locked();
    await released;
  });
  return {
    ready: Promise.race([ready, done]),
    release: async () => {
      release();
      await done;
    },
  };
}

/** 等到有请求卡在业务头（employment_business_objects）的行锁上；`stop` 为真（请求已经返回）就不再等。 */
async function waitForHeadWaiter(db: Db, stop: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (stop()) return;
    const found = rows(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%employment_business_objects%'`),
    ) as { n: number }[];
    if (found[0]!.n >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('没有请求卡在业务头行锁上');
}

/** 全行快照：同时捕获新增与原地改写，“零写入”拿它比。 */
async function state(w: LinkageWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result: Record<string, unknown> = {};
    for (const table of [
      'employment_employees',
      'employment_business_objects',
      'employment_payload_versions',
      'employment_state_events',
      'employment_records',
      'employment_activation_attempts',
      'employment_outbox',
      'transfer_requests',
      'transfer_linkage_versions',
      'transfer_linkage_runs',
      'transfer_linkage_items',
      'transfer_draft_slots',
      'audit_events',
      'command_ledger',
    ]) {
      const found = await tx.execute(sql`SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t
        WHERE tenant_id=${w.session.tenant.id} ORDER BY to_jsonb(t)::text`);
      result[table] = rows(found);
    }
    return result;
  });
}

interface Scenario {
  readonly w: LinkageWorld;
  readonly rights: ReturnType<typeof revocable>['rights'];
  /** 被另一事务持有的行：员工行或业务头。 */
  readonly hold: { readonly table: 'employees' | 'heads'; readonly id: string };
  readonly send: () => Promise<Response>;
}

/**
 * 屏障：持锁 → 发请求 → 等它排到锁上 → （revoke 时）收回范围 → 放锁。
 * `waited` 为假说明请求没有排到锁上就已返回（夹具没走到窗口），断言里单独判，避免用例空过。
 */
async function race(s: Scenario, revoke: boolean) {
  const held = holdRow(s.w.db, s.w.session.tenant.id, s.hold.table, s.hold.id);
  await held.ready;
  let done = false;
  const response = s.send();
  void response.finally(() => (done = true));
  if (s.hold.table === 'employees') await waitForLockWaiters(s.w.db, 1, () => done);
  else await waitForHeadWaiter(s.w.db, () => done);
  const waited = !done;
  if (revoke) {
    s.rights.scope = undefined;
    s.rights.emptyScope = true;
  }
  await held.release();
  return { waited, response: await response };
}

const refused = (status: number) => [403, 404].includes(status);

/** 一个入口的两条用例：等锁期间收回范围 → 拒绝且零写入；对照：没收回 → 等完锁后照常成功。 */
function entryCases(name: string, build: (label: string) => Promise<Scenario>, success: number | readonly number[]) {
  const accepted = Array.isArray(success) ? success : [success];
  describe.runIf(pg)(name, () => {
    it('等锁期间数据范围被收回：放锁后按收回后的授权拒绝，零写入', async () => {
      const s = await build(`f560-${uniqueSuffix()}`);
      const before = await state(s.w);
      const r = await race(s, true);
      expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
      const text = await r.response.clone().text();
      expect(refused(r.response.status), `等锁期间撤权后应 403 / 404，实际 ${r.response.status}：${text}`).toBe(true);
      expect(await state(s.w)).toEqual(before);
    });

    it('对照：范围没被收回：等完锁后照常成功（修前合法路径仍成功）', async () => {
      const s = await build(`f560-${uniqueSuffix()}-ok`);
      const before = await state(s.w);
      const r = await race(s, false);
      expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
      expect(accepted, await r.response.clone().text()).toContain(r.response.status);
      expect(await state(s.w)).not.toEqual(before);
    });
  });
}

/** 入口放行、事务内可撤权的 API（见文件头）。 */
function revocableApi(w: LinkageWorld, at: string) {
  const { rights, authorize } = revocable();
  const api = tenantApi(w.db, { authorize, clock: () => new Date(at) });
  const request = (method: string, path: string, options: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, `${BASE}${path}`, { ...w.as, ...options });
  return { rights, request };
}

const transferBody = (w: LinkageWorld, extra: Record<string, unknown> = {}) => ({
  initiator: 'hr',
  transferTypeCode: 'cross_department',
  mode: 'application',
  submit: false,
  effectiveDate: D,
  fields: { departmentId: w.to.id },
  ...extra,
});

async function transferWorld(label: string, at = DRAFT_AT) {
  const w = await linkageWorld(database().db, label);
  const person = await w.hire('合成调动员工');
  return { w, person, ...revocableApi(w, at) };
}

// 入口 1：发起 / 覆盖暂存（POST /transfers/employees/:id，sameOrderCreateGuard）
entryCases(
  'F-560 入口 1 发起调动 POST /transfers/employees/:id',
  async (label) => {
    const { w, person, rights, request } = await transferWorld(label);
    const revision = (await w.session.getEmployee(person.employee.id)).revision;
    return {
      w,
      rights,
      hold: { table: 'employees', id: person.employee.id },
      send: () =>
        request('POST', `/transfers/employees/${person.employee.id}`, { ifMatch: revision, body: transferBody(w) }),
    };
  },
  201,
);

// 入口 2：联动保存（PUT /transfers/:id/linkage，sameOrderScopeGuard），分别持有员工行与业务头
for (const table of ['employees', 'heads'] as const) {
  entryCases(
    `F-560 入口 2 联动保存 PUT /transfers/:id/linkage（持有${table === 'employees' ? '员工行' : '业务头'}）`,
    async (label) => {
      const { w, person, rights, request } = await transferWorld(label);
      const draft = await w.saved(await w.transfer(person, { submit: false }));
      return {
        w,
        rights,
        hold: { table, id: table === 'employees' ? person.employee.id : draft.id },
        send: () =>
          request('PUT', `/transfers/${draft.id}/linkage`, { ifMatch: draft.revision, body: { adjustSalary: true } }),
      };
    },
    200,
  );
}

// 入口 3：通用新建调动（POST /employees/:id/businesses，genericCapacityCreateGuard；执行体里两次取参与者锁）
entryCases(
  'F-560 入口 3 通用新建调动 POST /employees/:id/businesses',
  async (label) => {
    const { w, person, rights, request } = await transferWorld(label);
    const revision = (await w.session.getEmployee(person.employee.id)).revision;
    return {
      w,
      rights,
      hold: { table: 'employees', id: person.employee.id },
      send: () =>
        request('POST', `/employees/${person.employee.id}/businesses`, {
          ifMatch: revision,
          body: { kind: 'transfer', mode: 'application', effectiveDate: D, fields: { departmentId: w.to.id } },
        }),
    };
  },
  201,
);

/** AC-LNK-04 / DEC-052：接收人汇报给待转交下属，转交将形成环，主调动生效而子项失败。 */
async function failedLinkage(w: LinkageWorld, person: Person) {
  const subordinate = await w.hire('合成下属', { directManagerId: person.employee.id });
  const receiver = await w.hire('合成接收人', { directManagerId: subordinate.employee.id });
  const business = await w.saved(
    await w.transfer(person, {
      linkage: {
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' }],
        },
      },
    }),
  );
  await w.approve(business, '2026-10-02T01:00:00Z');
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({
    activated: [business.id],
    failed: [],
    errors: [],
  });
  const item = (await w.linkage(business.id)).dutyTransfer!.items[0]!;
  expect(item).toMatchObject({ status: 'failed', subordinateId: subordinate.employee.id });
  return { path: `/transfers/linkage-items/${item.id}/retry`, revision: item.revision };
}

/** AC-TRF-31 / DEC-183：审批通过后出现同类型在途合同，到期时整单失败。 */
async function failedActivation(w: LinkageWorld, person: Person) {
  const current = await w.contract(person.employee.id);
  const business = await w.saved(await w.transfer(person, { linkage: { contract: { targetId: current.id } } }));
  await w.approve(business, '2026-10-02T01:00:00Z');
  await w.contract(person.employee.id, { effectiveDate: '2026-12-01', endDate: '2027-11-30' }, 'application');
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({
    activated: [],
    failed: [business.id],
    errors: [],
  });
  const failed = await w.business(business.id);
  expect(failed).toMatchObject({ status: 'approved', activation: { status: 'failed' } });
  return { path: `/businesses/${business.id}/activation/retry`, revision: failed.revision };
}

// 入口 4、5：失败子项重试 / 生效重试（sameOrderScopeGuard）
for (const [name, prepare] of [
  ['入口 4 联动子项重试 POST /transfers/linkage-items/:id/retry', failedLinkage],
  ['入口 5 生效重试 POST /businesses/:id/activation/retry', failedActivation],
] as const) {
  entryCases(
    `F-560 ${name}`,
    async (label) => {
      const w = await linkageWorld(database().db, label);
      const person = await w.hire('合成调动员工');
      const target = await prepare(w, person);
      const { rights, request } = revocableApi(w, RETRY_AT);
      return {
        w,
        rights,
        hold: { table: 'employees', id: person.employee.id },
        send: () => request('POST', target.path, { ifMatch: target.revision, body: {} }),
      };
    },
    200,
  );
}

/** 非调动单据：在职试用员工的转正申请草稿（通用 PATCH / 删除走 sameOrderWriteGuard，原先因没有调动请求行而什么都不锁）。 */
async function regularizationDraft(label: string) {
  const w = await linkageWorld(database().db, label);
  const { employee } = await w.hired('合成转正员工', { probation: true });
  const current = await w.session.getEmployee(employee.id);
  const draft = await w.session.business(
    employee.id,
    { kind: 'regularization', mode: 'application', effectiveDate: '2026-10-20', fields: {} },
    current.revision,
  );
  return { w, employee, draft, ...revocableApi(w, DRAFT_AT) };
}

// 入口 6：通用 PATCH 作用于非调动单据（sameOrderWriteGuard，持有业务头）
entryCases(
  'F-560 入口 6 通用 PATCH /businesses/:id（转正草稿，持有业务头）',
  async (label) => {
    const { w, draft, rights, request } = await regularizationDraft(label);
    return {
      w,
      rights,
      hold: { table: 'heads', id: draft.id },
      send: () =>
        request('PATCH', `/businesses/${draft.id}`, { ifMatch: draft.revision, body: { effectiveDate: '2026-10-21' } }),
    };
  },
  200,
);

// 入口 7：通用删除作用于非调动单据（transitionWriteGuard → sameOrderWriteGuard，持有员工行）
entryCases(
  'F-560 入口 7 通用 DELETE /businesses/:id（转正草稿，持有员工行）',
  async (label) => {
    const { w, employee, draft, rights, request } = await regularizationDraft(label);
    return {
      w,
      rights,
      hold: { table: 'employees', id: employee.id },
      send: () => request('DELETE', `/businesses/${draft.id}`, { ifMatch: draft.revision }),
    };
  },
  200,
);
