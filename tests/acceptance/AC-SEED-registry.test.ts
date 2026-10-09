/**
 * DEC-361 种子补装登记表：各模块登记自己的预置数据（模块、数据集编码、版本、全部编码、已有编码查询、按缺失编码安装），
 * 新租户开通与平台回补命令走同一个 installMissingSeeds，避免两套安装逻辑：
 * - 只补缺失的编码，已有编码（含租户改名 / 停用 / 定制的）一律不动，重复执行无副作用；
 * - 回补是平台命令：只认平台运营身份、显式指定租户、命令台账幂等（同命令 ID 重放返回原结果）、可按模块筛选；
 * - 安装时拿到系统写入上下文（租户、操作人、命令 ID），由登记项自己同事务写业务数据与审计（DEC-216）。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  installMissingSeeds,
  registerSeed,
  registeredSeeds,
  type SeedWriteContext,
} from '../../apps/api/src/seeds/registry.js';
import { newUser, PLATFORM, provisioned, seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

/** 内存里的假租户数据：key = 租户 ID，值 = 该租户已有的预置编码（含被租户“定制”过的）。 */
const store = new Map<string, Map<string, string>>();
const seen: SeedWriteContext[] = [];
const CODES = ['a', 'b', 'c'];
registerSeed({
  module: 'test-mod',
  key: 'letters',
  version: 2,
  codes: CODES,
  existing: async (_tx, tenantId) => new Set(store.get(tenantId)?.keys() ?? []),
  install: async (_tx, write, missing) => {
    seen.push(write);
    const rows = store.get(write.tenantId) ?? new Map<string, string>();
    for (const code of missing) rows.set(code, `预置-${code}`);
    store.set(write.tenantId, rows);
  },
});
registerSeed({
  module: 'other-mod',
  key: 'numbers',
  version: 1,
  codes: ['1'],
  existing: async () => new Set(['1']),
  install: async () => {
    throw new Error('已全部存在，不应调用安装');
  },
});

async function legacyTenant(label: string) {
  const db = testDb().db;
  const api = tenantApi(db, { authorize: undefined });
  const operator = await seedOperator(db, `ops-${label}`);
  const admin = await newUser(db, `admin-${label}`);
  const exception = await newUser(db, `exception-${label}`);
  const result = await provisioned(api, operator, {
    firstAdminUserId: admin.id,
    exceptionAdminUserId: exception.id,
    licenses: [{ licenseType: 'core_hr', quota: 10 }],
  });
  return { api, operator, admin, tenant: result.tenant.id };
}
const backfill = (
  api: ReturnType<typeof tenantApi>,
  user: string,
  tenant: string,
  body: object = {},
  extra: object = {},
) => api.request('POST', `${PLATFORM}/tenants/${tenant}/seeds/backfill`, { user, body, ...extra });

describe('DEC-361 登记表与统一安装', () => {
  it('同一模块 + 数据集编码不能重复登记；登记项带模块 / 编码 / 版本', () => {
    expect(() =>
      registerSeed({
        module: 'test-mod',
        key: 'letters',
        version: 3,
        codes: [],
        existing: async () => new Set(),
        install: async () => {},
      }),
    ).toThrow(/已登记/);
    expect(registeredSeeds().map((entry) => `${entry.module}/${entry.key}@${entry.version}`)).toEqual(
      expect.arrayContaining(['test-mod/letters@2', 'other-mod/numbers@1']),
    );
  });

  it('只补缺失编码、不动已有（含定制）；重复执行无副作用；按模块筛选', async () => {
    const db = testDb().db;
    const tenant = randomUUID();
    store.set(tenant, new Map([['b', '租户改过的名称']]));
    const write: SeedWriteContext = { tenantId: tenant, actorUserId: null, now: new Date(), commandId: 'seed-test' };
    const only = await withTenant(db, tenant, (tx) => installMissingSeeds(tx, write, { modules: ['other-mod'] }));
    expect(only).toEqual([{ module: 'other-mod', key: 'numbers', version: 1, installed: [], existing: 1 }]);
    expect([...store.get(tenant)!.keys()]).toEqual(['b']);

    const first = await withTenant(db, tenant, (tx) => installMissingSeeds(tx, write, { modules: ['test-mod'] }));
    expect(first).toEqual([{ module: 'test-mod', key: 'letters', version: 2, installed: ['a', 'c'], existing: 1 }]);
    expect(store.get(tenant)!.get('b')).toBe('租户改过的名称');
    const snapshot = [...store.get(tenant)!.entries()];
    const again = await withTenant(db, tenant, (tx) => installMissingSeeds(tx, write, { modules: ['test-mod'] }));
    expect(again).toEqual([{ module: 'test-mod', key: 'letters', version: 2, installed: [], existing: 3 }]);
    expect([...store.get(tenant)!.entries()]).toEqual(snapshot);
    expect(seen.at(-1)).toMatchObject({ tenantId: tenant, commandId: 'seed-test' });
  });

  it('新租户开通走同一登记表：登记项被安装一次，拿到开通命令的写入上下文', async () => {
    const t = await legacyTenant('seed-provision');
    expect([...(store.get(t.tenant)?.keys() ?? [])].sort()).toEqual(CODES);
    expect(seen.filter((write) => write.tenantId === t.tenant)).toHaveLength(1);
  });
});

describe('DEC-361 平台回补命令 POST /api/platform/tenants/:tenantId/seeds/backfill', () => {
  it('补齐缺失编码、保留租户定制；重复执行无变化；只认平台运营身份；租户不存在 404；未知模块 400', async () => {
    const t = await legacyTenant('seed-backfill');
    store.get(t.tenant)!.delete('a');
    store.get(t.tenant)!.set('b', '租户定制');
    const denied = await backfill(t.api, t.admin.id, t.tenant);
    expect(denied.status).toBe(403);
    expect([...store.get(t.tenant)!.keys()].sort()).toEqual(['b', 'c']);
    expect((await backfill(t.api, t.operator.id, randomUUID())).status).toBe(404);
    const unknown = await backfill(t.api, t.operator.id, t.tenant, { modules: ['nope'] });
    expect(unknown.status).toBe(400);
    const extra = await backfill(t.api, t.operator.id, t.tenant, { other: 1 });
    expect(extra.status).toBe(400);
    expect([...store.get(t.tenant)!.keys()].sort()).toEqual(['b', 'c']);

    const first = await backfill(t.api, t.operator.id, t.tenant);
    expect(first.status, await first.clone().text()).toBe(200);
    const body = (await first.json()) as { items: { module: string; key: string; installed: string[] }[] };
    expect(body.items.find((item) => item.module === 'test-mod')).toMatchObject({ installed: ['a'] });
    expect(store.get(t.tenant)!.get('b')).toBe('租户定制');
    const after = [...store.get(t.tenant)!.entries()];
    const again = (await (await backfill(t.api, t.operator.id, t.tenant)).json()) as typeof body;
    expect(again.items.every((item) => item.installed.length === 0)).toBe(true);
    expect([...store.get(t.tenant)!.entries()]).toEqual(after);
  });

  it('按模块筛选；同一命令 ID 重放返回原结果且不再安装', async () => {
    const t = await legacyTenant('seed-backfill-replay');
    store.get(t.tenant)!.clear();
    const key = randomUUID();
    const first = await backfill(t.api, t.operator.id, t.tenant, { modules: ['other-mod'] }, { idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(store.get(t.tenant)!.size).toBe(0);
    const scoped = await backfill(
      t.api,
      t.operator.id,
      t.tenant,
      { modules: ['test-mod'] },
      { idempotencyKey: randomUUID() },
    );
    const original = await scoped.json();
    expect(store.get(t.tenant)!.size).toBe(3);
    store.get(t.tenant)!.delete('c');
    const key2 = randomUUID();
    const send = () => backfill(t.api, t.operator.id, t.tenant, { modules: ['test-mod'] }, { idempotencyKey: key2 });
    const one = await send();
    const replay = await send();
    expect([replay.status, await replay.json()]).toEqual([200, await one.json()]);
    expect(original).toBeDefined();
    expect(store.get(t.tenant)!.has('c')).toBe(true);
    store.get(t.tenant)!.delete('c');
    await send();
    expect(store.get(t.tenant)!.has('c')).toBe(false);
  });
});
