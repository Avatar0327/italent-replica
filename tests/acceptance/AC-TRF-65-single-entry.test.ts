/**
 * AC-TRF-65 ⑪⑫（F-036-S4 第 5 轮，DEC-993）：同单重放守卫的“单入口”——所有会阻塞的取锁都在读授权之前做完，
 * 授权只读一次，之后的业务范围复核、台账复核与回执裁剪只用这一份范围（真 PG，行锁屏障）。
 * ⑪ 参与员工集合在“取锁之后、读授权之前”变大：重放（直接 / 失败回查）不得在读授权之后再等锁，等锁期间收回的授权必须被看到。
 * ⑫ 回执裁剪用命令事务采用的当前范围，而不是入口范围：重放等锁期间只收回部分范围，单据仍可见（200），
 *    范围外员工的经理标识被裁掉；范围没变时回执与首次逐字节相同。
 * 第 6 轮（DEC-996）：
 * ⑬ 员工锁全部先于业务头：首轮规划已有甲、乙两名参与者，取锁后丙又进入集合；重放等丙的员工锁期间不得已持有甲、乙的业务头。
 * ⑭ 回执确定性序列化：范围不变时首次响应与重放（直接 / 失败回查）的原始文本逐字节一致（真 PG 与 PGlite 都跑）。
 * ⑮ 请求新带入的下属查无此人：取锁阶段只记下、不报错，同键异内容仍是 409 IDEMPOTENCY_CONFLICT，新键才是业务校验 400。
 * 夹具：甲＝部门 HR 重放的调动草稿所属员工；乙＝与甲同部门的另一名员工（⑪：把甲设为乙的虚线经理后进入甲的离职清空参与集合）；
 * 丙＝UUID 最大的第三名员工（⑬：取锁之后才把甲设为丙的虚线经理）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import type * as TransferLocks from '../../apps/api/src/modules/employment/transfer-locks.js';
import { waitForLockWaiters } from './AC-TRF-F181a-support.js';
import { BASE, LATER, betaWorld, ok, scopedHr, selfWorld, snapshotOf } from './AC-TRF-F036S4-support.js';

// 失败后回查：让命令主事务的 guard.before 第一次抛错，runCommand 随后走 replayAfterFailure 的回查出口。
// afterFirstLock：重放请求第一次取参与员工锁（lockTransferParticipants）返回后执行一次——用来在“取锁之后、读授权之前 / 之后”
// 这个窗口里让别的经办人提交改动；每次武装只触发一次，`fired` 记触发次数，防止夹具没走到窗口时用例空过。
const hooks = vi.hoisted(() => ({
  failMainTransaction: false,
  afterFirstLock: undefined as undefined | (() => Promise<void>),
  fired: 0,
}));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<typeof Commands>();
  return {
    ...original,
    runCommand: (...args: Parameters<typeof original.runCommand>) => {
      const [db, ctx, command] = args;
      const guard = command.guard;
      if (!hooks.failMainTransaction || !guard) return original.runCommand(db, ctx, command);
      hooks.failMainTransaction = false;
      let calls = 0;
      const flaky = {
        ...guard,
        before: async (tx: Parameters<typeof guard.before>[0]) => {
          if (calls++ === 0) throw new Error('模拟主事务并发冲突');
          await guard.before(tx);
        },
      };
      return original.runCommand(db, ctx, { ...command, guard: flaky });
    },
  };
});
vi.mock('../../apps/api/src/modules/employment/transfer-locks.js', async (importOriginal) => {
  const original = await importOriginal<typeof TransferLocks>();
  return {
    ...original,
    lockTransferParticipants: async (...args: Parameters<typeof original.lockTransferParticipants>) => {
      const outcome = await original.lockTransferParticipants(...args);
      const hook = hooks.afterFirstLock;
      hooks.afterFirstLock = undefined;
      if (hook) {
        hooks.fired += 1;
        await hook();
      }
      return outcome;
    },
  };
});

const database = useTestDb();
const pg = Boolean(process.env.TEST_DATABASE_URL);

/** 另开一个事务持有员工行锁直到 release：模拟“另一名经办人正在改这名员工”。 */
function holdEmployeeLock(db: Parameters<typeof withTenant>[0], tenantId: string, employeeId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const done = withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${tenantId} AND id=${employeeId}::uuid FOR UPDATE`);
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

type Db = Parameters<typeof withTenant>[0];
const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

/**
 * 这些员工（employees）或他们的业务头（heads）里，此刻被别的事务锁住了几行：另开事务 FOR UPDATE SKIP LOCKED，
 * 拿到的即刻随事务结束放掉，不等锁。⑬ 用它在重放等锁时看重放已持有哪些锁。
 */
async function lockedRows(db: Db, tenantId: string, what: 'employees' | 'heads', ids: readonly string[]) {
  const list = sql`${`{${ids.join(',')}}`}::uuid[]`;
  const from =
    what === 'employees'
      ? sql`FROM employment_employees WHERE tenant_id=${tenantId} AND id=ANY(${list})`
      : sql`FROM employment_business_objects WHERE tenant_id=${tenantId} AND employee_id=ANY(${list})`;
  return withTenant(db, tenantId, async (tx) => {
    const all = rows(await tx.execute(sql`SELECT id ${from}`)).length;
    const free = rows(await tx.execute(sql`SELECT id ${from} FOR UPDATE SKIP LOCKED`)).length;
    return { all, locked: all - free };
  });
}

/**
 * ⑪ 夹具：甲（较小 UUID，持有调动草稿）、乙（较大 UUID：新进参与者排在已持锁的甲之后，取锁是阻塞而不是顺序冲突）。
 * 部门 HR 首次 PATCH 草稿（命令 K0）成功；管理员再给甲建一张离职草稿（待落地的离职，落地时会清空仍承担的下属上级）。
 * ⑬（`people = 3`）：再加 UUID 最大的丙，且建草稿前先把甲设为乙的虚线经理——重放的首轮规划就有甲、乙两名参与者。
 * 首次回执按原始文本留存（firstText），逐字节比对重放用（⑭，DEC-996）。
 */
async function growthWorld(label: string, people: 2 | 3 = 2) {
  const s = await selfWorld(database().db, label);
  const staff = [];
  for (const name of ['合成员工一', '合成员工二', '合成员工三'].slice(0, people)) staff.push(await s.employee(name));
  const [alpha, beta, gamma] = staff.sort((x, y) => (x.employeeId.toLowerCase() < y.employeeId.toLowerCase() ? -1 : 1));
  if (gamma) await ok(await s.hrEditCurrent(beta!, { dottedManagerId: alpha!.employeeId }));
  const draft = await s.draftOf(alpha!);
  const hr = await scopedHr(s);
  const body = { effectiveDate: LATER };
  const k0 = { revision: (await s.show(draft.id)).revision, key: `k0-${label}` };
  const firstText = await (await ok(await s.patch(hr, draft.id, body, k0))).text();
  const firstBody = JSON.parse(firstText);
  const employee = await s.w.json<{ revision: number }>(
    await s.w.request(s.w.hr.id, 'GET', `${BASE}/employees/${alpha!.employeeId}`),
  );
  await s.w.json(
    await s.w.request(s.w.hr.id, 'POST', `${BASE}/employees/${alpha!.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-30', fields: {} },
    }),
    201,
  );
  const before = await snapshotOf(s, draft.id);
  return { s, alpha: alpha!, beta: beta!, gamma, draft, hr, body, k0, firstText, firstBody, before };
}

/**
 * 参与集合变大屏障：重放第一次取锁返回后（授权还没读）——
 *   1. 另一名经办人把甲设为乙的虚线经理（提交；乙因此进入甲离职的清空参与集合）；
 *   2. 另一名经办人随即持有乙的员工行锁；
 * 重放必须在读授权之前等到乙的锁（等锁期间管理员收回甲所在部门范围），放锁后按当前授权判：404，不返回原回执。
 * 旧实现第二次规划（读完范围之后）才发现乙并在那时等锁，等完锁沿用等锁前的范围，返回 200 与原回执。
 * `kind = 'recheck'`：重放的命令主事务先“并发冲突”失败，走失败回查出口，同样不得读授权之后再等锁。
 */
async function growthRace(label: string, kind: 'direct' | 'recheck', revoke: boolean) {
  const g = await growthWorld(label);
  const { w } = g.s;
  let held: ReturnType<typeof holdEmployeeLock> | undefined;
  hooks.fired = 0;
  hooks.afterFirstLock = async () => {
    await ok(await g.s.hrEditCurrent(g.beta, { dottedManagerId: g.alpha.employeeId }));
    held = holdEmployeeLock(w.db, w.tenant.id, g.beta.employeeId);
    await held.ready;
  };
  if (kind === 'recheck') hooks.failMainTransaction = true;
  let replayDone = false;
  const response = g.s.patch(g.hr, g.draft.id, g.body, g.k0);
  void response.finally(() => (replayDone = true));
  // 重放必须卡在乙的员工锁上；未修复的实现里它在读完范围之后才排到锁上，修复后在读授权之前排到锁上。
  // 任意一种都在它返回之前收回范围；若它根本没有排到锁上就返回了，由下面的断言判结果。
  await waitForLockWaiters(w.db, 1, () => replayDone);
  const waited = !replayDone;
  if (revoke) await g.hr.revokeScope();
  await held?.release();
  hooks.failMainTransaction = false;
  const replay = await response;
  return { ...g, replay, fired: hooks.fired, waited };
}

describe.runIf(pg)('AC-TRF-65 ⑪ 参与员工集合在读授权前变大：取锁都在读授权之前，不在读授权之后等锁（真 PG）', () => {
  describe.each(['direct', 'recheck'] as const)('缓存命中的同键重放（%s）', (kind) => {
    it('重放等乙的锁期间甲所在部门范围被收回：404，零写入，不返回原回执', async () => {
      const r = await growthRace(`f036s4-65-11-${kind}`, kind, true);
      expect(r.fired, '夹具没有走到“取锁之后”的窗口').toBe(1);
      expect(r.waited, '重放没有排到乙的员工锁上，屏障没有生效').toBe(true);
      expect(r.replay.status, await r.replay.clone().text()).toBe(404);
      expect(JSON.stringify(await r.replay.json())).not.toContain(String(r.firstBody.id));
      // 被拒的重放没有写任何东西：载荷版本、来源行、字段值与四个字段的来源都与首次执行之后一致。
      expect(await snapshotOf(r.s, r.draft.id)).toEqual(r.before);
    });

    it('对照：参与集合变大但范围没被收回：合法重放等完乙的锁后仍是 200，返回首次回执原文，单据不变', async () => {
      const r = await growthRace(`f036s4-65-11-${kind}-grow`, kind, false);
      expect(r.fired).toBe(1);
      expect(r.waited).toBe(true);
      expect(r.replay.status, await r.replay.clone().text()).toBe(200);
      expect(await r.replay.text()).toBe(r.firstText);
      expect(await snapshotOf(r.s, r.draft.id)).toEqual(r.before);
    });
  });

  it.each(['direct', 'recheck'] as const)(
    '对照：参与集合没变的合法重放仍是 200，返回首次回执原文（%s）',
    async (kind) => {
      const g = await growthWorld(`f036s4-65-11-${kind}-same`);
      if (kind === 'recheck') hooks.failMainTransaction = true;
      const replay = await ok(await g.s.patch(g.hr, g.draft.id, g.body, g.k0));
      hooks.failMainTransaction = false;
      expect(await replay.text()).toBe(g.firstText);
      expect(await snapshotOf(g.s, g.draft.id)).toEqual(g.before);
    },
  );
});

/** 经理标识里等于 `id` 的都换成 null——范围外员工的标识按回执裁剪规则应被裁掉。 */
function withoutManager(value: unknown, id: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutManager(item, id));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      typeof field === 'string' && field.toLowerCase() === id.toLowerCase() ? null : withoutManager(field, id),
    ]),
  );
}

/**
 * ⑫ 夹具：部门 HR 的数据范围＝甲所在部门 + 乙所在的另一部门；HR 首次 PATCH（命令 K0）把草稿的虚线经理设为乙，回执里带乙的标识。
 * 重放等甲的员工行锁期间管理员只收回乙所在部门的范围：甲仍可见，锁内复核都通过，回执里乙的标识必须按当前范围裁掉。
 */
async function partialRevocationRace(label: string, kind: 'direct' | 'recheck', revoke: boolean) {
  const b = await betaWorld(database().db, label);
  const { w } = b.s;
  const otherDepartment = await w.org('合成乙部门');
  const outsider = await w.person('合成范围外员工', otherDepartment);
  const hr = await scopedHr(b.s, [otherDepartment]);
  const body = { fields: { dottedManagerId: outsider.employeeId }, effectiveDate: LATER };
  const k0 = { revision: (await b.s.show(b.draft.id)).revision, key: `k0-${label}` };
  const firstText = await (await ok(await b.s.patch(hr, b.draft.id, body, k0))).text();
  const firstBody = JSON.parse(firstText);
  const before = await snapshotOf(b.s, b.draft.id);
  const held = holdEmployeeLock(w.db, w.tenant.id, b.person.employeeId);
  await held.ready;
  if (kind === 'recheck') hooks.failMainTransaction = true;
  let replayDone = false;
  const response = b.s.patch(hr, b.draft.id, body, k0);
  void response.finally(() => (replayDone = true));
  await waitForLockWaiters(w.db, 1, () => replayDone);
  const waited = !replayDone;
  if (revoke) await hr.setScope([b.s.source]);
  await held.release();
  hooks.failMainTransaction = false;
  return { b, outsider, firstText, firstBody, before, waited, replay: await response };
}

describe.runIf(pg)('AC-TRF-65 ⑫ 回执裁剪用命令事务采用的当前范围，不用入口范围（真 PG）', () => {
  describe.each(['direct', 'recheck'] as const)('缓存命中的同键重放（%s）', (kind) => {
    it('重放等锁期间只收回乙所在部门的范围：单据仍 200，乙的虚线经理标识被裁成 null，其余与首次回执相同', async () => {
      const r = await partialRevocationRace(`f036s4-65-12-${kind}`, kind, true);
      expect(r.waited, '重放没有排到甲的员工锁上，屏障没有生效').toBe(true);
      expect(r.replay.status, await r.replay.clone().text()).toBe(200);
      // 首次回执（范围含乙所在部门）里确实带着乙的标识，对照才有意义。
      expect(r.firstBody.fields.dottedManagerId).toBe(r.outsider.employeeId);
      const replayed = await r.replay.json();
      expect(JSON.stringify(replayed).toLowerCase()).not.toContain(r.outsider.employeeId.toLowerCase());
      expect(replayed.fields.dottedManagerId).toBeNull();
      expect(replayed).toEqual(withoutManager(r.firstBody, r.outsider.employeeId));
      expect(await snapshotOf(r.b.s, r.b.draft.id)).toEqual(r.before);
    });

    it('对照：范围没变时重放回执与首次逐字节相同（乙的标识保留）', async () => {
      const r = await partialRevocationRace(`f036s4-65-12-${kind}-ok`, kind, false);
      expect(r.replay.status, await r.replay.clone().text()).toBe(200);
      // DEC-996：比原始文本，不比解析后的对象——首次来自执行对象、重放来自台账 jsonb，键序不同时解析后仍相等。
      expect(await r.replay.text()).toBe(r.firstText);
      expect(await snapshotOf(r.b.s, r.b.draft.id)).toEqual(r.before);
    });
  });
});

/**
 * ⑬ 屏障：重放首轮取锁返回后（此时已持甲、乙的员工锁）——另一名经办人把甲设为丙的虚线经理（提交；丙因此进入甲离职的清空集合），
 * 随即持有丙的员工行锁。重放补锁时等丙的员工锁；等锁期间另开事务看甲、乙的业务头：一行都不得被重放锁住（员工锁全部先于业务头）。
 * 旧实现每轮取员工锁后立刻锁这一轮参与者的业务头，第二轮在持有甲、乙业务头时等丙的员工锁。
 */
async function splitRace(label: string, kind: 'direct' | 'recheck') {
  const g = await growthWorld(label, 3);
  const { w } = g.s;
  const pair = [g.alpha.employeeId, g.beta.employeeId];
  const probe = async () => ({
    employees: await lockedRows(w.db, w.tenant.id, 'employees', pair),
    heads: await lockedRows(w.db, w.tenant.id, 'heads', pair),
  });
  let held: ReturnType<typeof holdEmployeeLock> | undefined;
  let atFirstLock: Awaited<ReturnType<typeof probe>> | undefined;
  hooks.fired = 0;
  hooks.afterFirstLock = async () => {
    atFirstLock = await probe();
    await ok(await g.s.hrEditCurrent(g.gamma!, { dottedManagerId: g.alpha.employeeId }));
    held = holdEmployeeLock(w.db, w.tenant.id, g.gamma!.employeeId);
    await held.ready;
  };
  if (kind === 'recheck') hooks.failMainTransaction = true;
  let replayDone = false;
  const response = g.s.patch(g.hr, g.draft.id, g.body, g.k0);
  void response.finally(() => (replayDone = true));
  await waitForLockWaiters(w.db, 1, () => replayDone);
  const waited = !replayDone;
  const whileWaiting = waited ? await probe() : undefined;
  await held?.release();
  hooks.failMainTransaction = false;
  return { ...g, replay: await response, fired: hooks.fired, waited, atFirstLock, whileWaiting };
}

describe.runIf(pg)('AC-TRF-65 ⑬ 员工锁全部先于业务头：补锁循环不在持有业务头时等员工锁（真 PG）', () => {
  it.each(['direct', 'recheck'] as const)(
    '首轮已有甲、乙，取锁后丙进入集合：等丙的锁时甲、乙的业务头一行未锁；放锁后 200 且回执原文与首次一致（%s）',
    async (kind) => {
      const r = await splitRace(`f036s4-65-13-${kind}`, kind);
      expect(r.fired, '夹具没有走到“取锁之后”的窗口').toBe(1);
      expect(r.waited, '重放没有排到丙的员工锁上，屏障没有生效').toBe(true);
      expect(r.whileWaiting!.heads.all, '甲、乙名下没有业务头，断言不成立').toBeGreaterThan(0);
      expect(r.whileWaiting, '重放等丙的员工锁时已持有甲、乙的业务头').toEqual({
        employees: { all: 2, locked: 2 },
        heads: { all: r.whileWaiting!.heads.all, locked: 0 },
      });
      expect(r.atFirstLock, '首轮规划应已锁住甲、乙两名员工，且还没取业务头').toEqual({
        employees: { all: 2, locked: 2 },
        heads: { all: r.atFirstLock!.heads.all, locked: 0 },
      });
      expect(r.replay.status, await r.replay.clone().text()).toBe(200);
      expect(await r.replay.text()).toBe(r.firstText);
      expect(await snapshotOf(r.s, r.draft.id)).toEqual(r.before);
    },
  );
});

describe('AC-TRF-65 ⑭ 回执确定性序列化：范围不变时首次响应与重放逐字节一致（DEC-996）', () => {
  it.each(['direct', 'recheck'] as const)('同键同内容重放的原始文本与首次相同（%s）', async (kind) => {
    const b = await betaWorld(database().db, `f036s4-65-14-${kind}`);
    const otherDepartment = await b.s.w.org('合成乙部门');
    const outsider = await b.s.w.person('合成范围外员工', otherDepartment);
    const hr = await scopedHr(b.s, [otherDepartment]);
    // 回执带嵌套对象（fields、before 等）与范围内另一部门员工的经理标识：键序不同就能看出来。
    const body = { fields: { dottedManagerId: outsider.employeeId }, effectiveDate: LATER };
    const k0 = { revision: (await b.s.show(b.draft.id)).revision, key: `k0-f036s4-65-14-${kind}` };
    const firstText = await (await ok(await b.s.patch(hr, b.draft.id, body, k0))).text();
    expect(JSON.parse(firstText).fields.dottedManagerId).toBe(outsider.employeeId);
    if (kind === 'recheck') hooks.failMainTransaction = true;
    const replay = await ok(await b.s.patch(hr, b.draft.id, body, k0));
    hooks.failMainTransaction = false;
    expect(await replay.text()).toBe(firstText);
  });
});

async function refusal(response: Response) {
  const parsed = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: parsed.error.code, reason: parsed.error.details?.reason };
}

describe('AC-TRF-65 ⑮ 请求新带入的下属查无此人：取锁阶段只记下，不遮蔽同键异内容的 409', () => {
  it.each(['direct', 'recheck'] as const)(
    '同键异内容 409 IDEMPOTENCY_CONFLICT；新键同一无效下属 400 TRANSFER_PERSON_NOT_ELIGIBLE；同键同内容返回原回执（%s）',
    async (kind) => {
      const s = await selfWorld(database().db, `f036s4-65-15-${kind}`);
      const person = await s.employee('合成员工');
      const draft = await s.draftOf(person);
      const hr = await scopedHr(s);
      const body = { effectiveDate: LATER };
      const k0 = { revision: (await s.show(draft.id)).revision, key: `k0-f036s4-65-15-${kind}` };
      const firstText = await (await ok(await s.patch(hr, draft.id, body, k0))).text();
      const before = await snapshotOf(s, draft.id);
      const invalid = { fields: { addedSubordinateIds: [randomUUID()] }, effectiveDate: LATER };
      if (kind === 'recheck') hooks.failMainTransaction = true;
      expect(await refusal(await s.patch(hr, draft.id, invalid, k0))).toEqual({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        reason: undefined,
      });
      hooks.failMainTransaction = false;
      const fresh = { revision: (await s.show(draft.id)).revision, key: `k1-f036s4-65-15-${kind}` };
      expect(await refusal(await s.patch(hr, draft.id, invalid, fresh))).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
      });
      const replay = await ok(await s.patch(hr, draft.id, body, k0));
      expect(await replay.text()).toBe(firstText);
      expect(await snapshotOf(s, draft.id)).toEqual(before);
    },
  );
});
