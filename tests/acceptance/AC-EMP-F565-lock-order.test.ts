/**
 * AC-EMP-F565（F-565，F-560 卡外遗留）：其余任职写入口的锁序与授权读取时序，以及员工行锁级与外键子表约定。
 *
 * F-560 把任职写入口统一成“员工行 → 业务头 → 封口 → 读授权”，但遗留四处：
 * ① 通用新建里不需要容量确认的类型（入职、转正等）没有同单守卫：授权在入口读完，等员工行锁期间被收回也沿用旧范围写入；
 * ③ 走 exitCommandGuard 的离职 / 退休入口在锁外读授权并缓存，等锁之后执行体仍用旧范围；
 * ② 合同定时任务两处与人员 lockPerson 仍对员工行用 FOR UPDATE（与外键子行插入的 KEY SHARE 冲突，也会和只持 NO KEY UPDATE 的
 *   任职入口形成升级死锁），员工主键 / 外键被引用的唯一键从不被改写，FOR NO KEY UPDATE 足够；
 * ④ 往 personnel_attachments 等外键子表插行必须先取员工行锁，此前没有约定也没有守卫。
 *
 * 屏障（真 PG，普通角色 app_owner）：另一事务持有员工行 → 发请求并等它排到锁上 → 收回数据范围 → 放锁，请求必须按收回后的授权
 * 拒绝（403 / 404）且零写入；对照组不收回，等完锁后照常成功（修前合法路径仍成功）。夹具见 support/lock-barrier.ts。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { lockPerson, type PersonnelContext } from '../../apps/api/src/modules/personnel/store.js';
import { contractWorld } from './AC-CT-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { gateWorld, leaveBody, type GateWorld } from './AC-EXIT-gate-support.js';
import { personnelSession } from './AC-SUB-support.js';
import { entryCases, pg, race, rows, type Scenario } from './support/lock-barrier.js';
import './support/exit-gate-enforced.js';
import { revocable } from './support/revocable-rights.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
const TODAY = '2026-10-06T01:00:00Z';

/** 入口放行、事务内可撤权的 API（见文件头）。 */
function revocableApi(w: GateWorld) {
  const { rights, authorize } = revocable();
  const api = tenantApi(w.db, { authorize, clock: () => new Date(TODAY) });
  const request = (method: string, path: string, options: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, `${BASE}${path}`, { ...w.as, ...options });
  return { rights, request };
}

const scene = async (label: string) => ({ w: await gateWorld(database().db, label) });

// ───────────────────────── ① 通用新建：不需要容量确认的类型 ─────────────────────────

// 入职：POST /employees/:id/businesses kind=hire（无守卫 → 走同单守卫）
entryCases(
  'f565',
  'F-565 ① 通用新建入职 POST /employees/:id/businesses kind=hire',
  async (label) => {
    const { w } = await scene(label);
    const { rights, request } = revocableApi(w);
    const employee = await w.session.employee('合成入职员工');
    return {
      w,
      rights,
      hold: { table: 'employees', id: employee.id },
      send: () =>
        request('POST', `/employees/${employee.id}/businesses`, {
          ifMatch: employee.revision,
          body: {
            kind: 'hire',
            mode: 'direct',
            effectiveDate: '2026-09-01',
            loginEmail: loginEmailOf(employee.id),
            fields: { departmentId: w.from.id },
          },
        }),
    } satisfies Scenario;
  },
  201,
);

// 转正：通用入口 kind=regularization 经 createRegularizationViaBusinesses（同样没有守卫）
entryCases(
  'f565',
  'F-565 ① 通用新建转正 POST /employees/:id/businesses kind=regularization',
  async (label) => {
    const { w } = await scene(label);
    const { rights, request } = revocableApi(w);
    const { employee } = await w.hired('合成转正员工', { probation: true });
    const revision = (await w.session.getEmployee(employee.id)).revision;
    return {
      w,
      rights,
      hold: { table: 'employees', id: employee.id },
      send: () =>
        request('POST', `/employees/${employee.id}/businesses`, {
          ifMatch: revision,
          body: {
            kind: 'regularization',
            mode: 'direct',
            effectiveDate: '2026-10-06',
            fields: {},
            probationResult: 'normal',
          },
        }),
    } satisfies Scenario;
  },
  201,
);

// ───────────────────────── ③ 离职 / 退休入口：先取锁、锁内读授权 ─────────────────────────

const exitTables = ['exit_requests'] as const;

// 专用入口新建离职：POST /exits/employees/:id（exitCommandGuard 'create'）
entryCases(
  'f565',
  'F-565 ③ 专用入口新建离职 POST /exits/employees/:id',
  async (label) => {
    const { w } = await scene(label);
    const { rights, request } = revocableApi(w);
    const { employee } = await w.hired('合成离职员工');
    const revision = (await w.session.getEmployee(employee.id)).revision;
    return {
      w,
      rights,
      hold: { table: 'employees', id: employee.id },
      extraTables: exitTables,
      send: () =>
        request('POST', `/exits/employees/${employee.id}`, {
          ifMatch: revision,
          body: { mode: 'application', lastWorkDate: '2026-10-20', fields: {} },
        }),
    } satisfies Scenario;
  },
  201,
);

// 通用入口新建离职：POST /employees/:id/businesses kind=leave（同一个 exitCommandGuard）
entryCases(
  'f565',
  'F-565 ③ 通用入口新建离职 POST /employees/:id/businesses kind=leave',
  async (label) => {
    const { w } = await scene(label);
    const { rights, request } = revocableApi(w);
    const { employee } = await w.hired('合成离职员工');
    const revision = (await w.session.getEmployee(employee.id)).revision;
    return {
      w,
      rights,
      hold: { table: 'employees', id: employee.id },
      extraTables: exitTables,
      send: () =>
        request('POST', `/employees/${employee.id}/businesses`, {
          ifMatch: revision,
          body: leaveBody('2026-10-20'),
        }),
    } satisfies Scenario;
  },
  201,
);

// 离职单提交：POST /exits/:id/submit（exitCommandGuard 'submit'，按业务头定位）
entryCases(
  'f565',
  'F-565 ③ 离职单提交 POST /exits/:id/submit',
  async (label) => {
    const { w } = await scene(label);
    const { rights, request } = revocableApi(w);
    const { employee } = await w.hired('合成离职员工');
    const draft = await w.createdLeave(employee.id, leaveBody('2026-10-20'));
    return {
      w,
      rights,
      hold: { table: 'employees', id: employee.id },
      extraTables: exitTables,
      send: () => request('POST', `/exits/${draft.id}/submit`, { ifMatch: draft.revision, body: {} }),
    } satisfies Scenario;
  },
  200,
);

// ───────────────────────── ② 员工行锁级：lockPerson / 合同定时任务不挡外键子行插入 ─────────────────────────

/**
 * 另开事务对员工行取 FOR KEY SHARE 并保持打开，直到 release：外键子行插入检查引用时取的就是这个行锁。
 * 直接用行锁而不插真实子行，是因为 personnel_attachments 当前没有给 app_user 的 INSERT 授权（见下方 ④ 的说明）。
 */
function holdChildInsert(w: GateWorld, employeeId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let inserted!: () => void;
  const ready = new Promise<void>((resolve) => (inserted = resolve));
  const done = withTenant(w.db, w.session.tenant.id, async (tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${w.session.tenant.id}
      AND id=${employeeId}::uuid FOR KEY SHARE`);
    inserted();
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

describe.runIf(pg)('F-565 ② 员工行锁级 FOR NO KEY UPDATE', () => {
  it('lockPerson 不被“已插外键子行（KEY SHARE）”的事务阻塞', async () => {
    const { w } = await scene(`f565-lp-${uniqueSuffix()}`);
    const { employee } = await w.hired('合成人员');
    const child = holdChildInsert(w, employee.id);
    await child.ready;
    try {
      const lockedRow = await withTenant(w.db, w.session.tenant.id, async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        return lockPerson(tx, { tenantId: w.session.tenant.id } as PersonnelContext, employee.id);
      });
      expect(lockedRow).toMatchObject({ id: employee.id });
    } finally {
      await child.release();
    }
  });

  it('合同到期任务（SKIP LOCKED）遇到外键子行插入时仍能取到员工行并落地，不报 locked', async () => {
    const w = await contractWorld(database().db, `f565-ct-${uniqueSuffix()}`);
    w.setNow('2026-09-30T01:00:00Z');
    const contract = await w.create();
    w.setNow('2026-10-01T01:00:00Z');
    await w.settings({ autoTerminate: true });
    const holder = gate(w);
    const child = holdChildInsert(holder, w.employee.id);
    await child.ready;
    try {
      const result = await runContractJobs(
        w.db,
        { tenantId: w.session.tenant.id },
        { clock: () => new Date('2026-10-01T01:00:00Z'), authorize: allowAll },
      );
      expect(result.runs[0]?.outcomes).toEqual([
        expect.objectContaining({ id: contract.id, kind: 'expire', state: 'succeeded' }),
      ]);
    } finally {
      await child.release();
    }
  });

  it('真持有员工行 NO KEY UPDATE 的事务仍让定时任务 SKIP LOCKED 跳过（语义不变）', async () => {
    const w = await contractWorld(database().db, `f565-skip-${uniqueSuffix()}`);
    w.setNow('2026-09-30T01:00:00Z');
    await w.create();
    w.setNow('2026-10-01T01:00:00Z');
    await w.settings({ autoTerminate: true });
    const outcomes = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${w.session.tenant.id}
        AND id=${w.employee.id}::uuid FOR NO KEY UPDATE`);
      const swept = await runContractJobs(
        w.db,
        { tenantId: w.session.tenant.id },
        { clock: () => new Date('2026-10-01T01:00:00Z'), authorize: allowAll },
      );
      return swept.runs[0]?.outcomes;
    });
    expect(outcomes).toEqual([expect.objectContaining({ kind: 'expire', state: 'locked' })]);
  });
});

/** contractWorld 只带 session / db，这里补出 holdChildInsert 需要的切面。 */
function gate(w: Awaited<ReturnType<typeof contractWorld>>) {
  return { db: w.db, session: w.session } as unknown as GateWorld;
}

// ───────────────────────── ② 静态守卫：员工行不得用裸 FOR UPDATE ─────────────────────────

const ROOT = join(import.meta.dirname, '../../');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });

/** 含 employment_employees 的 SQL 模板段里出现裸 `FOR UPDATE`（不是 `FOR NO KEY UPDATE`）。 */
export const bareEmployeeRowLocks = (source: string) =>
  [...source.matchAll(/`[^`]*`/g)]
    .map((match) => match[0])
    .filter((segment) => /employment_employees/.test(segment) && /(?<!NO KEY )FOR UPDATE/.test(segment));

describe('F-565 ② 静态守卫：员工行取锁一律 FOR NO KEY UPDATE', () => {
  it('apps/api/src 下没有对 employment_employees 的裸 FOR UPDATE', () => {
    const offenders = walk(join(ROOT, 'apps/api/src')).filter(
      (file) => bareEmployeeRowLocks(readFileSync(file, 'utf8')).length > 0,
    );
    expect(offenders.map((file) => file.replace(ROOT, ''))).toEqual([]);
  });

  it('变异自证：把 NO KEY 去掉的样例会被识别', () => {
    const good = 'sql`SELECT id FROM employment_employees WHERE id=${id} FOR NO KEY UPDATE SKIP LOCKED`';
    const bad = 'sql`SELECT id FROM employment_employees WHERE id=${id} FOR UPDATE SKIP LOCKED`';
    expect(bareEmployeeRowLocks(good)).toEqual([]);
    expect(bareEmployeeRowLocks(bad)).toHaveLength(1);
  });
});

// ───────────────────────── ④ 外键子表插行前先取员工行锁 ─────────────────────────

/**
 * 注意：迁移 0024 建 personnel_attachments 时没有给运行时角色 app_user 授 INSERT（其余 personnel_* 表都授了），
 * 所以普通角色下这条路由放锁后会 42501 → 503，PGlite / 超级用户下则正常 201。授权缺口是独立遗留（需迁移，不在本任务范围，见 PR 的后补 F 候选）；
 * 本任务只关心“插子行之前先取员工行锁”，故“排队等锁”用 waited 判，放锁后的结果按授权现状分别断言，补上授权后自动收紧为 201。
 */
const insertGranted = async (db: ReturnType<typeof database>['db']) =>
  (
    rows(await db.execute(sql`SELECT has_table_privilege('app_user','personnel_attachments','INSERT') AS ok`)) as {
      ok: boolean;
    }[]
  )[0]!.ok;

describe.runIf(pg)('F-565 ④ 登记人员附件先取员工行锁', () => {
  async function attachmentScene(label: string) {
    const db = database().db;
    const p = await personnelSession(db, label);
    const w = { db, session: { tenant: { id: p.tenant.id } } };
    const send = () =>
      p.request('POST', `/employees/${p.employee.id}/attachments`, {
        ifMatch: 0,
        body: { purpose: 'photo', filename: 'a.png', contentType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) },
      });
    return { p, w, send };
  }
  const expected = async (db: ReturnType<typeof database>['db']) => ((await insertGranted(db)) ? 201 : 503);

  it('员工行已被另一事务以 NO KEY UPDATE 持有时，登记附件排队等锁（修前只取 KEY SHARE，不排队）', async () => {
    const { p, w, send } = await attachmentScene(`f565-att-${uniqueSuffix()}`);
    const r = await race(
      { w, rights: {}, hold: { table: 'employees', id: p.employee.id, level: 'no-key' }, send },
      false,
    );
    expect(r.waited, '登记附件没有排到员工行锁上：插外键子行前未先取员工行锁').toBe(true);
    expect(r.response.status, await r.response.clone().text()).toBe(await expected(w.db));
  });

  it('对照：没有人持锁时登记附件照常办理（授权现状下的结果不变）', async () => {
    const { w, send } = await attachmentScene(`f565-att-ok-${uniqueSuffix()}`);
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(await expected(w.db));
  });
});

/**
 * 约定守卫：personnel 模块里往 personnel_attachments 插行的函数，插入之前必须先 lockPerson / lockEmploymentEmployee。
 * 取“插入语句所在函数”的文本（自上一个顶层 function / export 起到插入处），要求其中出现取锁调用。
 */
export const unlockedChildInserts = (source: string, table: string) => {
  const insert = new RegExp(`insert\\(tx,\\s*'${table}'`, 'g');
  const found: number[] = [];
  for (const match of source.matchAll(insert)) {
    const head = source.slice(0, match.index);
    const start = Math.max(
      head.lastIndexOf('\nexport '),
      head.lastIndexOf('\nasync function '),
      head.lastIndexOf('\nfunction '),
    );
    if (!/lockPerson\(|lockEmploymentEmployee\(/.test(source.slice(start, match.index))) found.push(match.index!);
  }
  return found;
};

describe('F-565 ④ 静态守卫：外键子表插行前先取员工行锁', () => {
  it('personnel 模块里往 personnel_attachments 插行的函数都先取了员工行锁', () => {
    const dir = join(ROOT, 'apps/api/src/modules/personnel');
    const offenders = walk(dir).filter(
      (file) => unlockedChildInserts(readFileSync(file, 'utf8'), 'personnel_attachments').length > 0,
    );
    expect(offenders.map((file) => file.replace(ROOT, ''))).toEqual([]);
  });

  it('变异自证：去掉取锁的样例会被识别，带取锁的样例通过', () => {
    const locked = [
      '\nexport async function registerAttachment(tx) {',
      '  await lockPerson(tx, ctx, employeeId);',
      "  await insert(tx, 'personnel_attachments', row);",
      '}',
    ].join('\n');
    const mutated = locked.replace('  await lockPerson(tx, ctx, employeeId);\n', '');
    expect(unlockedChildInserts(locked, 'personnel_attachments')).toEqual([]);
    expect(unlockedChildInserts(mutated, 'personnel_attachments')).toHaveLength(1);
  });
});
