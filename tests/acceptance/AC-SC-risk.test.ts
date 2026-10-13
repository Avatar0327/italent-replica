/** B4 首批红测：已确认的 #9 冻结 / 重放、#15 非空赋值、§4.2 定时登记。
 * DEC-449：清除保留行并恢复 computed，下一次计算可写。
 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { SUCCESSION_PRODUCERS } from '../../apps/api/src/modules/succession/calc-jobs.js';
import { SUCCESSION_CALC_KINDS } from '../../apps/api/src/modules/succession/calc-contract.js';
import { SUCCESSION_JOBS } from '../../apps/api/src/modules/succession/scheduler.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { SC_NOW, SC_TODAY, successionWorld, type SuccessionWorld } from './AC-SC-support.js';

let handle: DbHandle;
// 多工作区并行验证时完整迁移可能超过公共 useTestDb 的 60 秒；只放宽本文件建库时间。
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());
const db = () => handle;
const compute = '/maps/position/compute-risk';
const preferences = {
  rootOrgId: null as string | null,
  depth: 2,
  hiddenOrgIds: [] as string[],
  showKeyPositions: true,
  showPositionsWithoutSuccessor: true,
};
const frozen = (w: SuccessionWorld, runId: string) =>
  w.asTenant(async (tx) =>
    rowsOf<{ object_id: string }>(
      await tx.execute(sql`SELECT object_id FROM succession_calc_run_objects WHERE run_id=${runId}::uuid`),
    )
      .map((row) => row.object_id)
      .sort(),
  );

it('AC-SC-risk #9：层数与隐藏子树复用 C1；条件进入指纹，同键沿用首次冻结集合', async () => {
  const w = await successionWorld(db().db, 'sc-risk-freeze');
  const org = await w.org('风险组织');
  const hidden = await w.org('隐藏子树', org.id);
  const p1 = await w.position(org.id, '第一层');
  const p2 = await w.position(org.id, '第二层', { parents: { admin: { parentId: p1.id } } });
  await w.position(org.id, '第三层', { parents: { admin: { parentId: p2.id } } });
  await w.position(hidden.id, '隐藏职位');
  const body = { ...preferences, rootOrgId: org.id.toUpperCase(), hiddenOrgIds: [hidden.id] };
  const options = { ifMatch: 0, idempotencyKey: randomUUID(), body };
  const response = await w.request('POST', compute, options);
  expect(response.status, await response.clone().text()).toBe(202);
  const receipt = (await response.json()) as { runId: string };
  expect(Object.keys(receipt)).toEqual(['runId']);
  const displayed = await w.asTenant((tx) =>
    readMapDisplayScope(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        asOf: SC_TODAY,
        scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
      },
      'position',
      body,
      'submitted',
    ),
  );
  expect(displayed.sort()).toEqual([p1.id, p2.id].sort());
  expect(await frozen(w, receipt.runId)).toEqual(displayed);
  const added = await w.position(org.id, '冻结后新增');
  const replay = await w.request('POST', compute, { ...options, body: { ...body, rootOrgId: org.id } });
  expect(replay.status, await replay.clone().text()).toBe(202);
  expect(await replay.json()).toEqual(receipt);
  expect(await frozen(w, receipt.runId)).toEqual(displayed);
  expect((await w.request('POST', compute, { ...options, body: { ...body, depth: 3 } })).status).toBe(409);
  expect(await frozen(w, receipt.runId)).toEqual(displayed);
  const next = await w.request('POST', compute, { ...options, idempotencyKey: randomUUID() });
  expect(next.status, await next.clone().text()).toBe(202);
  expect(await frozen(w, ((await next.json()) as { runId: string }).runId)).toEqual([...displayed, added.id].sort());
});

it('AC-SC-risk #9：保存条件应用后，原命令不随偏好修改重新冻结', async () => {
  const w = await successionWorld(db().db, 'sc-risk-saved');
  const org = await w.org('保存筛选组织');
  const hidden = await w.org('保存隐藏组织', org.id);
  const visible = await w.position(org.id, '可见');
  const excluded = await w.position(hidden.id, '被隐藏');
  const save = (revision: number, hiddenOrgIds: string[]) =>
    w.request('PUT', '/maps/position/preferences', {
      ifMatch: revision,
      body: { ...preferences, rootOrgId: org.id, hiddenOrgIds },
    });
  expect((await save(0, [hidden.id])).status).toBe(200);
  const options = { ifMatch: 0, idempotencyKey: randomUUID(), body: {} };
  const first = await w.request('POST', compute, options);
  expect(first.status, await first.clone().text()).toBe(202);
  const receipt = (await first.json()) as { runId: string };
  expect(await frozen(w, receipt.runId)).toEqual([visible.id]);
  expect((await save(1, [])).status).toBe(200);
  const replay = await w.request('POST', compute, options);
  expect(replay.status, await replay.clone().text()).toBe(202);
  expect(await replay.json()).toEqual(receipt);
  expect(await frozen(w, receipt.runId)).toEqual([visible.id]);
  const next = await w.request('POST', compute, { ...options, idempotencyKey: randomUUID() });
  expect(next.status, await next.clone().text()).toBe(202);
  expect(await frozen(w, ((await next.json()) as { runId: string }).runId)).toEqual([visible.id, excluded.id].sort());
});

it('AC-SC-risk #9：非法条件返回 400，不新增 run', async () => {
  const w = await successionWorld(db().db, 'sc-risk-invalid');
  const read = () => w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`)));
  const before = await read();
  for (const body of [{ depth: 5 }, { rootOrgId: '不是 UUID' }, { showIncumbents: false }])
    expect((await w.request('POST', compute, { ifMatch: 0, body })).status).toBe(400);
  expect(await read()).toEqual(before);
});

it('AC-SC-risk #15：非空手动赋值可读、可重放，旧 revision 拒绝且结果不变', async () => {
  const w = await successionWorld(db().db, 'sc-risk-assign');
  const org = await w.org('赋值组织');
  const position = await w.position(org.id, '赋值职位');
  const created = await w.request('POST', '/risk-levels', {
    ifMatch: 0,
    body: { code: 'RISK', name: '风险等级', color: '#112233', description: '', enabled: true, rules: null },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const level = (await created.json()) as { id: string };
  const path = `/risk-results/${position.id}`;
  const options = { ifMatch: 0, idempotencyKey: randomUUID(), body: { levelId: level.id } };
  const assigned = await w.request('PUT', path, options);
  expect(assigned.status, await assigned.clone().text()).toBe(200);
  const result = await assigned.json();
  expect(result).toMatchObject({ positionId: position.id, levelId: level.id, method: 'manual', revision: 1 });
  const replay = await w.request('PUT', path, options);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toEqual(result);
  const list = await w.request('GET', '/risk-results');
  expect(list.status, await list.clone().text()).toBe(200);
  expect(((await list.json()) as { items: unknown[] }).items).toContainEqual(result);
  const read = () => w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT * FROM succession_risk_results`)));
  const before = await read();
  expect((await w.request('PUT', path, { ...options, idempotencyKey: randomUUID() })).status).toBe(409);
  expect(await read()).toEqual(before);
  const clear = { ifMatch: 1, idempotencyKey: randomUUID(), body: { levelId: null } };
  const cleared = await w.request('PUT', path, clear);
  expect(cleared.status, await cleared.clone().text()).toBe(200);
  expect(await cleared.json()).toMatchObject({
    positionId: position.id,
    levelId: null,
    method: 'computed',
    revision: 2,
  });
  const runs = await w.asTenant(async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`
    SELECT id FROM succession_calc_runs WHERE kind='position_risk' AND trigger='manual'`),
    ),
  );
  expect(runs).toHaveLength(1);
  expect(await frozen(w, runs[0]!.id)).toEqual([position.id]);
  expect((await w.request('PUT', path, clear)).status).toBe(200);
  expect(
    await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
    SELECT id FROM succession_calc_runs WHERE kind='position_risk'`),
      ),
    ),
  ).toEqual(runs);
  expect(await read()).toHaveLength(1);
});

it('AC-SC-risk §4.2：生产者、worker、调度登记；同业务日幂等，次日新建 run', async () => {
  const w = await successionWorld(db().db, 'sc-risk-schedule');
  const org = await w.org('定时组织');
  const position = await w.position(org.id, '定时关键职位');
  await w.position(org.id, '非关键职位', { isKey: false });
  const producer = SUCCESSION_PRODUCERS.find((item) => item.kind === 'position_risk');
  expect(producer, 'B4 必须登记真实按租户生产者').toBeDefined();
  expect(SUCCESSION_CALC_KINDS.some((item) => item.kind === 'position_risk')).toBe(true);
  expect(SUCCESSION_JOBS.some((item) => item.kind === 'position_risk')).toBe(true);
  const midnight = new Date('2026-09-30T16:00:00Z');
  for (const time of [midnight, SC_NOW, new Date('2026-10-01T16:00:00Z')])
    await w.asTenant((tx) => producer!.runTenant(tx, { id: w.tenant.id, timezone: 'Asia/Shanghai' }, time));
  const runs = await w.asTenant(async (tx) =>
    rowsOf<{ id: string; date: string; key: string }>(
      await tx.execute(sql`SELECT id,business_date::text AS date,idempotency_key AS key FROM succession_calc_runs
        WHERE kind='position_risk' ORDER BY business_date`),
    ),
  );
  expect(runs.map(({ date, key }) => ({ date, key }))).toEqual(
    ['2026-10-01', '2026-10-02'].map((date) => ({ date, key: `position_risk:schedule:${w.tenant.id}:${date}` })),
  );
  for (const run of runs) expect(await frozen(w, run.id)).toEqual([position.id]);
});
