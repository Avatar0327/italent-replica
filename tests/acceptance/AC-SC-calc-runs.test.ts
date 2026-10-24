/** B3b：#10、§8.4；读 / 重试 / 重放与 worker 共用真实 run 表。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedTenantWithMember, tenantApi, allowAll } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { enqueueCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { defineCalcKinds, CalcObjectFailure } from '../../apps/api/src/modules/succession/calc-contract.js';
import { rowsOf } from './support/f048.js';
import { SUCCESSION_AUDIT } from '../../apps/api/src/modules/succession/audit-scope.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';

const testDb = useTestDb();
const now = new Date('2026-10-11T08:00:00Z');
const BASE = '/api/tenant/succession/calc-runs';
let seed: Awaited<ReturnType<typeof seedTenantWithMember>>;
const db = () => testDb().db;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db(), seed.tenant.id, fn);
const read = async (id: string) =>
  rowsOf<Record<string, unknown>>(
    await tx((t) => t.execute(sql`SELECT * FROM succession_calc_runs WHERE id=${id}::uuid`)),
  )[0]!;
const create = (ids: string[], requestedBy: string | null = seed.user.id) =>
  tx((t) =>
    enqueueCalcRun(
      t,
      {
        tenantId: seed.tenant.id,
        kind: 'org_stats',
        trigger: 'manual',
        commandId: randomUUID(),
        requestedBy,
        businessDate: '2026-10-11',
        objects: ids.map((objectId) => ({ objectType: 'org', objectId })),
      },
      now,
    ),
  );
const request = (api: ReturnType<typeof tenantApi>, path = '', method = 'GET', revision?: number, key?: string) =>
  api.request(method, BASE + path, {
    tenant: seed.tenant.id,
    user: seed.user.id,
    ...(method === 'POST' ? { body: {}, ifMatch: revision, idempotencyKey: key } : {}),
  });
function viewer(ids: string[], fields?: string[]) {
  const state = { ids, permitted: true, fields };
  const authorize = () => state.permitted;
  registerScopeProvider(authorize, {
    authorize: async () => state.permitted,
    scope: async () => ({ all: false, hasDataPermission: state.ids.length > 0, orgIds: state.ids, personIds: [] }),
    fields: async () =>
      new Set(
        state.fields ?? [
          'id',
          'revision',
          'kind',
          'trigger',
          'status',
          'requestedBy',
          'startedAt',
          'finishedAt',
          'visibleCounts',
          'failures',
        ],
      ),
  });
  return { state, api: tenantApi(db(), { authorize, clock: () => now }) };
}
const handlers = (execute: Parameters<typeof defineCalcKinds>[0][number]['execute']) =>
  defineCalcKinds([{ kind: 'org_stats', objectType: 'org', authorizePage: async () => seed.user.id, execute }]);
beforeAll(async () => {
  seed = await seedTenantWithMember(db(), 'sc-calc-api');
});

describe('AC-SC-calc-runs / AC-SC-projection', () => {
  it('已授权成员读取空租户返回 200 / 空列表', async () => {
    const res = await request(tenantApi(db()));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ items: [] });
  });
  it('整体门槛、当前可见计数与失败明细，scope 仅看全部身份可见', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const id = await create([a!, b!], null);
    await runCalcPage(
      db(),
      seed.tenant.id,
      id,
      handlers(async (_ctx, object) => {
        if (object.objectId === b) throw new CalcObjectFailure('SOURCE_REVOKED', true);
        return 'written';
      }),
      now,
    );
    const hr = viewer([a!]);
    const detail = await request(hr.api, `/${id}`);
    expect(detail.status).toBe(200);
    const view = await detail.json();
    expect(view).toMatchObject({ id, status: 'partial', visibleCounts: { total: 1, written: 1, failed: 0 } });
    expect(view).not.toHaveProperty('scope');
    expect(view).not.toHaveProperty('requestHash');
    const failures = await request(hr.api, `/${id}/failures`);
    expect(await failures.json()).toMatchObject({ items: [], total: 0 });
    hr.state.ids = [b!];
    const visible = await request(hr.api, `/${id}/failures`);
    expect(await visible.json()).toMatchObject({ items: [{ objectId: b, code: 'SOURCE_REVOKED' }], total: 1 });
    hr.state.ids = [];
    expect((await request(hr.api, `/${id}`)).status).toBe(404);
    const list = await request(hr.api);
    expect(await list.json()).toMatchObject({ items: [], total: 0 });
    const own = await create([a!]);
    expect(await (await request(hr.api, `/${own}`)).json()).toMatchObject({ visibleCounts: { total: 0 } });
    expect(await (await request(tenantApi(db()), `/${id}`)).json()).toHaveProperty('scope');
  });
  it('审计逐行归属：本人触发但无可见对象也不返回，范围恢复后可见', async () => {
    const org = randomUUID();
    const id = await create([org]);
    const spec = SUCCESSION_AUDIT.calcRun;
    expect(spec?.kind).toBe('rows');
    if (spec?.kind !== 'rows' || !spec.visible) throw new Error('缺少 calcRun 审计谓词');
    const visible = spec.visible;
    const logs = (orgIds: string[]) =>
      tx(async (t) =>
        rowsOf(
          await t.execute(sql`
      SELECT a.id FROM audit_events a WHERE a.object_id=${id} AND ${visible(
        { all: false, hasDataPermission: orgIds.length > 0, orgIds, personIds: [] },
        {
          objectId: sql`a.object_id`,
          org: sql`NULL`,
          before: sql`a.before`,
          after: sql`a.after`,
          commandId: sql`a.command_id`,
        },
        { tenantId: seed.tenant.id, userId: seed.user.id },
      )}`),
        ),
      );
    expect(await logs([])).toEqual([]);
    expect(await logs([org])).toHaveLength(1);
  });
  it('缺对象权、字段裁剪、非法 UUID 与跨租户均拒绝', async () => {
    const id = await create([randomUUID()]);
    const hr = viewer([], ['id', 'revision', 'status']);
    expect(await (await request(hr.api, `/${id}`)).json()).toEqual({ id, revision: 1, status: 'pending' });
    expect(await (await request(hr.api, `/${id}/failures`)).json()).toEqual({ items: [] });
    hr.state.permitted = false;
    expect((await request(hr.api, `/${id}`)).status).toBe(403);
    expect((await request(tenantApi(db()), '/bad-id')).status).toBe(400);
    const other = await seedTenantWithMember(db(), 'sc-other');
    expect(
      (
        await tenantApi(db()).request('GET', `${BASE}/${id}`, {
          tenant: other.tenant.id,
          user: other.user.id,
        })
      ).status,
    ).toBe(404);
  });
  it('blocked 重试、直接重放、同键异内容、范围撤销与按钮撤权', async () => {
    const org = randomUUID();
    const id = await create([org]);
    await runCalcPage(db(), seed.tenant.id, id, [], now);
    const before = await read(id);
    const key = randomUUID();
    const hr = viewer([org]);
    const response = await request(hr.api, `/${id}/retry`, 'POST', Number(before.revision), key);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ id, status: 'pending' });
    expect((await read(id)).attempt_no).toBe(Number(before.attempt_no) + 1);
    expect((await request(hr.api, `/${id}/retry`, 'POST', Number(before.revision), key)).status).toBe(200);
    expect((await request(hr.api, `/${id}/retry`, 'POST', 99, key)).status).toBe(409);
    hr.state.ids = [];
    const denied = await request(hr.api, `/${id}/retry`, 'POST', Number(before.revision), key);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { details: { reason: 'RUN_SCOPE_EXCEEDS_REQUESTER' } } });
    hr.state.permitted = false;
    expect((await request(hr.api, `/${id}/retry`, 'POST', Number(before.revision), key)).status).toBe(403);
    expect((await read(id)).attempt_no).toBe(Number(before.attempt_no) + 1);
  });
  it('partial 只检查可重试执行集合；永久失败不重跑；终态拒绝不写', async () => {
    const a = randomUUID(),
      b = randomUUID();
    const id = await create([a, b]);
    await runCalcPage(
      db(),
      seed.tenant.id,
      id,
      handlers(async (_ctx, object) => {
        throw new CalcObjectFailure(object.objectId === a ? 'STORAGE_UNAVAILABLE' : 'REVISION_CONFLICT', true);
      }),
      now,
    );
    const hr = viewer([a]);
    expect((await request(hr.api, `/${id}/retry`, 'POST', Number((await read(id)).revision))).status).toBe(200);
    const executed: string[] = [];
    await runCalcPage(
      db(),
      seed.tenant.id,
      id,
      handlers(async (_ctx, object) => {
        executed.push(object.objectId);
        return 'written';
      }),
      now,
    );
    expect(executed).toEqual([a]);
    const before = await read(id);
    const denied = await request(hr.api, `/${id}/retry`, 'POST', Number(before.revision));
    expect(denied.status).toBe(409);
    expect(await read(id)).toEqual(before);
  });
  it.each(['pending', 'running', 'succeeded', 'aborted'])('%s 不可重试，拒绝后 run 不变', async (status) => {
    const id = await create([]);
    await tx((t) => t.execute(sql`UPDATE succession_calc_runs SET status=${status} WHERE id=${id}::uuid`));
    const before = await read(id);
    const res = await request(tenantApi(db()), `/${id}/retry`, 'POST', Number(before.revision));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { reason: 'RUN_NOT_RETRYABLE' } } });
    expect(await read(id)).toEqual(before);
  });
  it('失败明细只按错误码与行号返回固定文案', async () => {
    const id = await create([randomUUID()]);
    await runCalcPage(
      db(),
      seed.tenant.id,
      id,
      handlers(async () => {
        throw new CalcObjectFailure('TYPE_CONVERSION', false, undefined, 2);
      }),
      now,
    );
    const res = await request(tenantApi(db()), `/${id}/failures`);
    expect(await res.json()).toMatchObject({
      items: [{ code: 'TYPE_CONVERSION', rowNo: 2, message: '第 2 行条件出错：比较或转换时类型不符' }],
    });
  });
  it('提交已成功但回包丢失，经失败回查重放返回同一投影，不再次重试', async () => {
    const id = await create([randomUUID()]);
    await runCalcPage(db(), seed.tenant.id, id, [], now);
    const actual = db();
    let lost = false;
    const transaction: Db['transaction'] = async (callback, config) => {
      const value = await actual.transaction(callback, config);
      if (!lost && value && typeof value === 'object' && 'status' in value && 'body' in value) {
        lost = true;
        throw new Error('合成提交回包丢失');
      }
      return value;
    };
    const wrapped = new Proxy(actual, {
      get: (target, key, receiver) => (key === 'transaction' ? transaction : Reflect.get(target, key, receiver)),
    });
    const before = await read(id);
    const res = await request(
      tenantApi(wrapped, { authorize: allowAll }),
      `/${id}/retry`,
      'POST',
      Number(before.revision),
    );
    expect(res.status).toBe(200);
    expect(lost).toBe(true);
    expect(await res.json()).toMatchObject({ id, status: 'pending' });
    expect((await read(id)).attempt_no).toBe(Number(before.attempt_no) + 1);
  });
  it.skipIf(!process.env.TEST_DATABASE_URL).each(['succeeded', 'partial'] as const)(
    '真 PG：retry 等待 worker 行锁后按最新 revision 拒绝（%s）',
    async (status) => {
      const id = await create([randomUUID()]);
      const before = await read(id);
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = runCalcPage(
        db(),
        seed.tenant.id,
        id,
        handlers(async () => {
          entered();
          await gate;
          if (status === 'partial') throw new CalcObjectFailure('SOURCE_REVOKED', true);
          return 'written';
        }),
        now,
      );
      await inside;
      const retry = request(tenantApi(db()), `/${id}/retry`, 'POST', Number(before.revision));
      await withRelease(release, async (cleanup) => {
        [worker, retry].forEach(cleanup.track);
        await waitForBlocked(db(), 1);
      });
      expect(await worker).toBe(status);
      const res = await retry;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
      expect(await read(id)).toMatchObject({ status, attempt_no: before.attempt_no });
      expect(
        await tx(async (t) =>
          rowsOf(
            await t.execute(sql`
      SELECT outcome,retryable FROM succession_calc_run_objects WHERE run_id=${id}::uuid`),
          ),
        ),
      ).toEqual([{ outcome: status === 'partial' ? 'failed' : 'written', retryable: status === 'partial' }]);
    },
  );
});
