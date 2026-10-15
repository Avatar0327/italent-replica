/**
 * AC-DM-19（字典部分，B60～62）/ B-67：离职类型、离职原因、离职去向三个字典（R2-T03 设计 §2.1、§4、§9.1）。
 * 只经公开 HTTP 接口与旧 main 已有的夹具：新增 / 改名 / 停用 / 调序由管理员完成，持任职记录查看权即可读；编码租户内唯一
 * （不分大小写）且保存后不可改；每个字典最多 500 项，满了新增 409、列表仍可读；停用项不可再选，已保存单据仍显示名称；
 * 预置编码与自助子集固定。另含转交时机配置项 exit.duty_transfer_timing（§2.2）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld, installExitSeeds, type ExitWorld } from './AC-EXIT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import type * as DictionaryService from '../../apps/api/src/modules/employment/exit-dictionaries.js';

const testDb = useTestDb();
const SERVICE = '../../apps/api/src/modules/employment/exit-dictionaries.js';
const PRESETS = {
  types: ['involuntary', 'voluntary'],
  reasons: ['family', 'personal'],
  whereabouts: ['other_industry', 'same_industry', 'startup'],
};
const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;
const audits = (w: ExitWorld, objectId: string) =>
  withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT action, object_type AS "objectType" FROM audit_events
      WHERE tenant_id = ${w.tenant.id} AND object_id = ${objectId}`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { action: string }[];
  });

describe('AC-DM-19 / B-67 预置项', () => {
  it('补装后三个字典各有预置编码（含自助子集）且全部启用；重复补装不覆盖租户改名；字典按租户隔离', async () => {
    const w = await exitWorld(testDb().db, 'seeds');
    for (const [kind, codes] of Object.entries(PRESETS)) {
      const items = await w.list(kind);
      expect(items.map((e) => e.code).sort()).toEqual(codes);
      expect(items.every((e) => e.enabled)).toBe(true);
    }
    const personal = (await w.list('reasons')).find((e) => e.code === 'personal')!;
    expect((await w.update('reasons', personal.id, personal.revision, { name: '租户改名' })).status).toBe(200);
    expect(await installExitSeeds(w.db, w.tenant.id)).toEqual([
      expect.objectContaining({ module: 'employment', key: 'exit-dictionaries', installed: [], existing: 7 }),
    ]);
    expect((await w.list('reasons')).find((e) => e.code === 'personal')!.name).toBe('租户改名');
    const other = await exitWorld(testDb().db, 'seeds-other');
    await w.added('types', { code: 'only_a', name: '只属于本租户' });
    expect((await other.list('types')).map((e) => e.code)).not.toContain('only_a');
    expect((await other.added('types', { code: 'only_a', name: '另一租户同编码' })).code).toBe('only_a');
  });
});

describe('AC-DM-19 / B-67 管理员维护字典', () => {
  it('新增 / 改名 / 停用 / 启用 / 调序；按显示顺序再按编码排列；enabled 筛选；每次写入 revision +1 并写配置审计', async () => {
    const w = await exitWorld(testDb().db, 'crud');
    const created = await w.added('types', { code: 'contract_end', name: '合同到期', displayOrder: 5 });
    expect(created).toMatchObject({ code: 'contract_end', enabled: true, displayOrder: 5, revision: 1 });
    expect(await w.added('reasons', { code: 'salary', name: '薪酬' })).toMatchObject({
      enabled: true,
      displayOrder: 0,
    });
    const steps = [
      [{ name: '劳动合同到期' }, { name: '劳动合同到期', displayOrder: 5, revision: 2 }],
      [
        { enabled: false, displayOrder: 1 },
        { enabled: false, displayOrder: 1, revision: 3 },
      ],
      [{ code: 'contract_end', name: '劳动合同到期' }, { revision: 4 }], // 带原编码视为未改
    ] as const;
    for (const [index, [body, expected]] of steps.entries()) {
      const response = await w.update('types', created.id, index + 1, body);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject(expected);
    }
    expect((await w.list('types', '?enabled=true')).map((e) => e.code)).not.toContain('contract_end');
    expect((await w.list('types', '?enabled=false')).map((e) => e.code)).toEqual(['contract_end']);
    expect((await w.list('types')).map((e) => e.code)).toEqual(['contract_end', 'voluntary', 'involuntary']);
    expect(await (await w.update('types', created.id, 4, { enabled: true })).json()).toMatchObject({ revision: 5 });
    const rows = await audits(w, created.id);
    expect(rows.map((r) => r.action)).toEqual(Array(5).fill('exit_dictionary.save'));
  });

  it('编码重复（不分大小写）409、改编码 400、revision 过期 409、输入非法 400、未知项 404，均无写入；不提供删除', async () => {
    const w = await exitWorld(testDb().db, 'conflicts');
    const entry = await w.added('whereabouts', { code: 'abroad', name: '出国' });
    const cases: [() => Promise<Response>, number, string?][] = [
      [() => w.add('reasons', { code: 'PERSONAL', name: '大写重复' }), 409, 'EXIT_DICTIONARY_CODE_TAKEN'],
      [() => w.update('whereabouts', entry.id, 1, { code: 'overseas' }), 400, 'EXIT_DICTIONARY_CODE_IMMUTABLE'],
      [() => w.update('whereabouts', entry.id, 9, { name: '出国深造' }), 409],
      [() => w.add('kinds', { code: 'x', name: 'x' }), 400],
      [() => w.request('GET', '/exits/dictionaries/kinds'), 400],
      [() => w.request('GET', '/exits/dictionaries/types?enabled=yes'), 400],
      [() => w.update('types', 'not-a-uuid', 1, { name: 'x' }), 400],
      [() => w.update('types', '00000000-0000-4000-8000-000000000000', 1, { name: 'x' }), 404],
      [() => w.add('types', { code: 'blank', name: '  ' }), 400],
      [() => w.add('types', { code: 'extra', name: '多余字段', kind: 'x' }), 400],
      [() => w.add('types', { code: 'rev', name: 'If-Match 非 0' }, { ifMatch: 3 }), 409],
    ];
    for (const [pending, status, reason] of cases) {
      const response = await pending();
      expect(response.status, await response.clone().text()).toBe(status);
      if (reason) expect((await error(response)).details).toMatchObject({ reason });
    }
    const removed = await w.request('DELETE', `/exits/dictionaries/whereabouts/${entry.id}`, { ifMatch: 1 });
    expect([404, 405]).toContain(removed.status);
    expect((await w.list('whereabouts')).find((e) => e.id === entry.id)).toMatchObject({ name: '出国', revision: 1 });
    expect((await w.list('types')).map((e) => e.code).sort()).toEqual(PRESETS.types);
    expect((await w.list('reasons')).filter((e) => e.code.toLowerCase() === 'personal')).toHaveLength(1);
  });

  it('每个字典最多 500 项：第 501 项 409 EXIT_DICTIONARY_LIMIT_REACHED、不写入不审计，列表仍整份可读', async () => {
    const w = await exitWorld(testDb().db, 'limit');
    const filled = await w.attempt(sql`INSERT INTO exit_types(tenant_id, code, name)
      SELECT ${w.tenant.id}, 'bulk_' || n, '批量' || n FROM generate_series(1, 498) n`);
    expect(filled).toBeUndefined();
    expect(await w.list('types')).toHaveLength(500);
    const rejected = await w.add('types', { code: 'one_more', name: '第 501 项' });
    expect(rejected.status).toBe(409);
    expect((await error(rejected)).details).toEqual({ reason: 'EXIT_DICTIONARY_LIMIT_REACHED', limit: 500 });
    const items = await w.list('types');
    expect(items).toHaveLength(500);
    expect(items.map((e) => e.code)).not.toContain('one_more');
    const disabled = items.find((e) => e.code === 'bulk_1')!;
    expect((await w.update('types', disabled.id, 1, { enabled: false })).status).toBe(200);
    expect((await w.add('types', { code: 'still_full', name: '停用不腾位' })).status).toBe(409);
    expect((await w.added('reasons', { code: 'other_dict', name: '其他字典不受影响' })).code).toBe('other_dict');
    const rows = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM audit_events WHERE tenant_id = ${w.tenant.id} AND after::text LIKE '%one_more%'`),
    );
    expect(Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows).toHaveLength(0);
  });
});

describe('AC-DM-19 / B-67 停用项不可选，已保存单据仍显示名称', () => {
  it('停用后选择校验 400 EXIT_DICTIONARY_DISABLED、未知编码 400 EXIT_DICTIONARY_UNKNOWN；已保存单按编码取到名称', async () => {
    const w = await exitWorld(testDb().db, 'disabled');
    const seeded = await w.seedExitBusiness({ exit_type_code: 'involuntary' });
    expect(seeded.error).toBeUndefined();
    const involuntary = (await w.list('types')).find((e) => e.code === 'involuntary')!;
    expect((await w.update('types', involuntary.id, involuntary.revision, { enabled: false })).status).toBe(200);
    // 选择校验 / 名称回显是 B2a / B5 的服务端端口，本批尚无公开入口：动态导入，模块缺失时断言失败而不是导入错误
    const service = (await import(SERVICE).catch(() => null)) as typeof DictionaryService | null;
    expect(service, '缺少离职字典服务').not.toBeNull();
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await expect(
        service!.assertExitDictionaryEnabled(tx, w.tenant.id, 'types', 'voluntary'),
      ).resolves.toBeUndefined();
      await expect(service!.assertExitDictionaryEnabled(tx, w.tenant.id, 'types', 'involuntary')).rejects.toMatchObject(
        {
          code: 'VALIDATION_FAILED',
          details: { reason: 'EXIT_DICTIONARY_DISABLED', dictionary: 'types', code: 'involuntary' },
        },
      );
      await expect(service!.assertExitDictionaryEnabled(tx, w.tenant.id, 'reasons', 'nope')).rejects.toMatchObject({
        details: { reason: 'EXIT_DICTIONARY_UNKNOWN' },
      });
      const names = await service!.exitDictionaryNames(tx, w.tenant.id, 'types', ['involuntary', 'missing']);
      expect(Object.fromEntries(names)).toEqual({ involuntary: '被动离职' });
    });
  });
});

describe('AC-DM-19 / B-67 权限（真实授权器）', () => {
  it('管理员可写；只有任职记录查看权的成员可读、写 403 且无写入；无查看权的成员读 403', async () => {
    const w = await exitWorld(testDb().db, 'auth');
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-01T01:00:00Z') });
    const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
    const asAdmin = { tenant: w.tenant.id, user: w.user.id };
    const seed = { db: w.db, tenant: w.tenant, admin: w.user, adminRecord, api, asAdmin };
    const [viewer, stranger] = [await addMember(seed, '离职查看人'), await addMember(seed, '无权限成员')];
    const profile = await createProfile(seed, 'exit-dictionary-viewer');
    const record = MODULE_OBJECTS.employmentRecord;
    const fields = record.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false }));
    const operations = { create: false, update: false, delete: false };
    const permission = { dataOperations: operations, fields, buttons: [] };
    expect((await setObjectPermission(seed, profile, permission, record.code)).status).toBe(200);
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, viewer.id, profile.id)).status).toBe(201);
    const as = (user: string, method: string, path: string, body?: unknown, ifMatch?: number) =>
      api.request(method, `/api/tenant/employment/exits/dictionaries${path}`, {
        tenant: w.tenant.id,
        user,
        body,
        ifMatch,
      });
    const created = await as(w.user.id, 'POST', '/types', { code: 'by_admin', name: '管理员新增' }, 0);
    expect(created.status, await created.clone().text()).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const read = await as(viewer.id, 'GET', '/types');
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain('by_admin');
    expect((await as(viewer.id, 'POST', '/types', { code: 'by_viewer', name: '查看人' }, 0)).status).toBe(403);
    expect((await as(viewer.id, 'PUT', `/types/${id}`, { name: '查看人改名' }, 1)).status).toBe(403);
    expect((await as(stranger.id, 'GET', '/types')).status).toBe(403);
    const types = await w.list('types');
    expect(types.map((e) => e.code)).not.toContain('by_viewer');
    expect(types.find((e) => e.id === id)).toMatchObject({ name: '管理员新增', revision: 1 });
  });
});

describe('AC-DM-19 §2.2 转交时机配置项 exit.duty_transfer_timing', () => {
  it('系统值 business_effective；租户覆盖只接受两个取值', async () => {
    const w = await exitWorld(testDb().db, 'timing');
    const put = (value: string) =>
      tenantApi(w.db).request('PUT', '/api/tenant/settings/exit.duty_transfer_timing', {
        tenant: w.tenant.id,
        user: w.user.id,
        ifMatch: 0,
        body: { value },
      });
    const read = await tenantApi(w.db).request('GET', '/api/tenant/settings/exit.duty_transfer_timing', {
      tenant: w.tenant.id,
      user: w.user.id,
    });
    expect(await read.json()).toMatchObject({ value: 'business_effective', source: 'system', revision: 0 });
    const invalid = await put('immediately');
    expect(invalid.status).toBe(400);
    expect((await error(invalid)).details).toMatchObject({ reason: 'SETTING_VALUE_INVALID' });
    expect(await (await put('approval_passed')).json()).toMatchObject({ value: 'approval_passed', source: 'tenant' });
  });
});
