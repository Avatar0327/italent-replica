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
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { CONTRACT_OBJECT } from '@italent/domain';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lockEmployee } from '../../apps/api/src/modules/contracts/context.js';
import type { ContractContext } from '../../apps/api/src/modules/contracts/context.js';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { employmentSession } from './AC-EMP-support.js';
import { linkageWorld, type LinkageWorld } from './AC-LNK-support.js';
import { waitForLockWaiters } from './AC-TRF-F181a-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
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
type Revoke = (rights: Scenario['rights']) => void;
/** 收回整份数据范围（事务内解析到空范围）。 */
const emptyRange: Revoke = (rights) => {
  rights.scope = undefined;
  rights.emptyScope = true;
};
/** 只收回合同对象的范围，任职等其他对象的范围不动。 */
const emptyContractRange: Revoke = (rights) => {
  rights.objectScopes = { [CONTRACT_OBJECT]: EMPTY_SCOPE };
};

async function race(s: Scenario, revoke: Revoke | false) {
  const held = holdRow(s.w.db, s.w.session.tenant.id, s.hold.table, s.hold.id);
  await held.ready;
  let done = false;
  const response = s.send();
  void response.finally(() => (done = true));
  if (s.hold.table === 'employees') await waitForLockWaiters(s.w.db, 1, () => done);
  else await waitForHeadWaiter(s.w.db, () => done);
  const waited = !done;
  if (revoke) revoke(s.rights);
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
      const r = await race(s, emptyRange);
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

// 入口 1 / 3 的反向对照：封口后才进来的不存在人员仍按原口径 400，不得因先封口改报 409
describe('F-560 封口后新增下属不存在：发起与通用新建仍报 400 TRANSFER_PERSON_NOT_ELIGIBLE', () => {
  const ghost = () => randomUUID();
  const expectEligibility = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' } } });
  };

  it('发起调动：新增下属不存在 → 400，业务表不留写入', async () => {
    const { w, person, request } = await transferWorld(`f560-ghost-${uniqueSuffix()}`);
    const revision = (await w.session.getEmployee(person.employee.id)).revision;
    const before = await state(w);
    await expectEligibility(
      await request('POST', `/transfers/employees/${person.employee.id}`, {
        ifMatch: revision,
        body: transferBody(w, { fields: { departmentId: w.to.id, addedSubordinateIds: [ghost()] } }),
      }),
    );
    expect(await state(w)).toEqual(before);
  });

  it('通用新建调动：新增下属不存在 → 400，业务表不留写入', async () => {
    const { w, person, request } = await transferWorld(`f560-ghost-${uniqueSuffix()}`);
    const revision = (await w.session.getEmployee(person.employee.id)).revision;
    const before = await state(w);
    await expectEligibility(
      await request('POST', `/employees/${person.employee.id}/businesses`, {
        ifMatch: revision,
        body: {
          kind: 'transfer',
          mode: 'application',
          effectiveDate: D,
          fields: { departmentId: w.to.id, addedSubordinateIds: [ghost()] },
        },
      }),
    );
    expect(await state(w)).toEqual(before);
  });
});

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

/**
 * 锁升级（F-560 卡片 §4）：生效落地时调动联动调合同写入口，员工行锁从 FOR NO KEY UPDATE（任职写入口）升级成
 * FOR UPDATE（合同的 lockEmployee）。FOR UPDATE 与外键子行插入持有的 FOR KEY SHARE 冲突：
 * 甲（调动生效）持 NO KEY UPDATE，升级时要等乙的 KEY SHARE 放掉；乙先插入带员工外键的子行（附件登记，KEY SHARE），
 * 再要员工行写锁——排在甲后面等甲。甲等乙、乙等甲，PostgreSQL 以 40P01 回滚其中一个。
 * 修复：合同的员工行锁与任职写入口同强度（FOR NO KEY UPDATE），升级不存在；员工主档的键列从不更新，不需要 FOR UPDATE。
 */
describe.runIf(pg)('F-560 员工行锁升级：任职写锁之后取合同员工锁不得升级成 FOR UPDATE', () => {
  async function schedule(label: string) {
    const db = database().db;
    const session = await employmentSession(db, label);
    const employee = await session.employee('合成锁升级员工');
    const tenantId = session.tenant.id;
    const ctx = { tenantId } as EmploymentContext;
    let aLocked!: () => void;
    const aHolds = new Promise<void>((resolve) => (aLocked = resolve));
    let bQueued = false;
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => 'committed',
        (error: { code?: string; cause?: { code?: string } }) => `error:${error.code ?? error.cause?.code}`,
      );
    // 乙：先登记附件（外键子行，持员工行 KEY SHARE），甲持锁之后再要员工行写锁。
    // 附件表的写权限只给迁移 owner（同 AC-EMP-F058 的证件照夹具）：按租户设上下文后直接用 owner 事务插入。
    const b = settle(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
        await tx.execute(sql`INSERT INTO personnel_attachments
          (tenant_id, employee_id, purpose, filename, content_type, byte_size, sha256, created_by)
          VALUES (${tenantId}, ${employee.id}::uuid, 'photo', 'a.png', 'image/png', 1, ${uniqueSuffix()},
            ${session.user.id}::uuid)`);
        await aHolds;
        bQueued = true;
        await lockEmploymentEmployee(tx as unknown as Tx, ctx, employee.id);
      }),
    );
    // 甲：任职写入口取员工行（NO KEY UPDATE），乙排上来之后再取合同的员工锁——旧实现在这里升级成 FOR UPDATE。
    const a = settle(
      withTenant(db, tenantId, async (tx) => {
        await lockEmploymentEmployee(tx, ctx, employee.id);
        aLocked();
        await waitForLockWaiters(db, 1, () => false);
        expect(bQueued).toBe(true);
        await lockEmployee(tx, ctx as unknown as ContractContext, employee.id);
      }),
    );
    return { a: await a, b: await b };
  }

  it('甲（任职写锁 → 合同员工锁）与乙（附件外键子行 → 员工写锁）交错：都提交，没有 40P01', async () => {
    const result = await schedule(`f560-up-${uniqueSuffix()}`);
    expect(result, '不得出现死锁（40P01）；旧实现下其中一个事务被回滚').toEqual({ a: 'committed', b: 'committed' });
  });
});

/**
 * 第 2 轮 P1-1：合同范围是授权输入，也要在封口之后、锁内重新解析。入口（事务外）解析的 contractScope 只是请求内快照，
 * 命令事务里照旧拿它判合同变更，等锁期间只撤合同范围（任职范围不动）后，HR 仍能保存合同变更。
 * 撤权只收合同对象的范围（objectScopes），任职对象与其他授权不变，所以 404 只能来自合同范围的重判。
 */
describe('F-560 第 2 轮 P1-1：合同范围封口后在锁内重新解析', () => {
  async function contractWorld(label: string, at = DRAFT_AT) {
    const world = await transferWorld(label, at);
    const target = await world.w.contract(world.person.employee.id);
    return { ...world, linkage: { contract: { targetId: target.id } } };
  }

  /** 发起：新建带合同变更的调动（sameOrderCreateGuard，持有员工行）。 */
  const initiate = async (label: string): Promise<Scenario> => {
    const { w, person, rights, request, linkage } = await contractWorld(label);
    const revision = (await w.session.getEmployee(person.employee.id)).revision;
    return {
      w,
      rights,
      hold: { table: 'employees', id: person.employee.id },
      send: () =>
        request('POST', `/transfers/employees/${person.employee.id}`, {
          ifMatch: revision,
          body: transferBody(w, { linkage }),
        }),
    };
  };

  /** 联动保存：给已有草稿加合同变更（sameOrderScopeGuard，持有员工行）。 */
  const save = async (label: string): Promise<Scenario> => {
    const { w, person, rights, request, linkage } = await contractWorld(label);
    const draft = await w.saved(await w.transfer(person, { submit: false }));
    return {
      w,
      rights,
      hold: { table: 'employees', id: person.employee.id },
      send: () => request('PUT', `/transfers/${draft.id}/linkage`, { ifMatch: draft.revision, body: linkage }),
    };
  };

  for (const [name, build, success] of [
    ['发起调动 POST /transfers/employees/:id', initiate, 201],
    ['联动保存 PUT /transfers/:id/linkage', save, 200],
  ] as const) {
    describe.runIf(pg)(name, () => {
      it('等锁期间只撤合同范围：放锁后 404，零写入', async () => {
        const s = await build(`f560-c-${uniqueSuffix()}`);
        const before = await state(s.w);
        const r = await race(s, emptyContractRange);
        expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
        expect(r.response.status, await r.response.clone().text()).toBe(404);
        expect(await state(s.w)).toEqual(before);
      });

      it('对照：合同范围没被撤：等完锁后照常保存合同变更', async () => {
        const s = await build(`f560-c-${uniqueSuffix()}-ok`);
        const before = await state(s.w);
        const r = await race(s, false);
        expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
        expect(r.response.status, await r.response.clone().text()).toBe(success);
        expect(await state(s.w)).not.toEqual(before);
      });
    });
  }

  it('同键重放：首次保存成功后只撤合同范围，重放 404，不返回缓存回执', async () => {
    const { w, person, rights, request, linkage } = await contractWorld(`f560-cr-${uniqueSuffix()}`);
    const draft = await w.saved(await w.transfer(person, { submit: false }));
    const key = `f560-replay-${uniqueSuffix()}`;
    const first = await request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: linkage,
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await state(w);
    rights.objectScopes = { [CONTRACT_OBJECT]: EMPTY_SCOPE };
    const replay = await request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: linkage,
      idempotencyKey: key,
    });
    expect(replay.status, await replay.clone().text()).toBe(404);
    expect(await state(w)).toEqual(before);
  });
});

/**
 * 第 2 轮 P2-1：覆盖暂存时被替换的旧草稿头，也要在封口前取锁。单人闭包的 lockTransferHeads 没有 businessId 什么都不锁，
 * 执行体里 releaseTransferDraft → transitionEmployment 才在旧草稿头上等锁——那时授权已经读完。
 */
describe.runIf(pg)('F-560 第 2 轮 P2-1：覆盖暂存的旧草稿头在封口前取锁', () => {
  async function overwrite(label: string): Promise<Scenario & { readonly employeeId: string }> {
    const { w, person, rights, request } = await transferWorld(label);
    const first = await request('POST', `/transfers/employees/${person.employee.id}`, {
      ifMatch: (await w.session.getEmployee(person.employee.id)).revision,
      body: transferBody(w),
    });
    const old = await w.saved(first);
    const employeeId = person.employee.id;
    const revision = (await w.session.getEmployee(person.employee.id)).revision;
    return {
      w,
      rights,
      employeeId,
      hold: { table: 'heads', id: old.id },
      send: () =>
        request('POST', `/transfers/employees/${person.employee.id}`, {
          ifMatch: revision,
          body: transferBody(w, { effectiveDate: '2026-10-12' }),
        }),
    };
  }

  const slotOf = async (w: LinkageWorld, employeeId: string) =>
    withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`SELECT business_id AS "businessId" FROM transfer_draft_slots
          WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`),
      ),
    );

  it('等旧草稿头期间数据范围被收回：放锁后 404，旧草稿与槽位原样保留，零写入', async () => {
    const s = await overwrite(`f560-ow-${uniqueSuffix()}`);
    const before = await state(s.w);
    const slot = await slotOf(s.w, s.employeeId);
    const r = await race(s, emptyRange);
    expect(r.waited, '请求没有排到旧草稿头的锁上，屏障没有生效').toBe(true);
    expect(refused(r.response.status), await r.response.clone().text()).toBe(true);
    expect(await state(s.w)).toEqual(before);
    expect(await slotOf(s.w, s.employeeId)).toEqual(slot);
  });

  it('对照：范围没被收回：等完旧草稿头后覆盖成功，旧草稿被替换', async () => {
    const s = await overwrite(`f560-ow-${uniqueSuffix()}-ok`);
    const r = await race(s, false);
    expect(r.waited, '请求没有排到旧草稿头的锁上，屏障没有生效').toBe(true);
    expect(r.response.status, await r.response.clone().text()).toBe(201);
    const created = (await r.response.json()) as { id: string };
    expect(await slotOf(s.w, s.employeeId)).toEqual([{ businessId: created.id }]);
  });
});
