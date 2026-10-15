/**
 * AC-DM-19（字典部分，B60～62）/ B-67：离职类型、离职原因、离职去向三个字典的读写（R2-T03 设计 §2.1、§4、§9.1）。
 * 新增 / 改名 / 停用 / 调序由管理员（tenant.employment.configuration.write）完成；持任职记录查看权即可读取；
 * 编码租户内唯一（不分大小写）且保存后不可改；停用项不可再选，已保存单据仍按编码显示名称；预置编码与自助子集固定。
 * 另含转交时机配置项 exit.duty_transfer_timing 的系统值与取值校验（§2.2）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { auditEvents, and, eq, exitRequests, withTenant } from '@italent/db';
import {
  EXIT_DICTIONARY_KINDS,
  EXIT_DICTIONARY_PRESETS,
  EXIT_SELF_REASON_CODES,
  EXIT_SELF_WHEREABOUTS_CODES,
  MODULE_OBJECTS,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  assertExitDictionaryEnabled,
  exitDictionaryNames,
} from '../../apps/api/src/modules/employment/exit-dictionaries.js';
import { exitWorld, installExitSeeds, type ExitWorld } from './AC-EXIT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function reason(response: Response) {
  return ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;
}
async function dictionaryAudits(w: ExitWorld, objectId: string) {
  return withTenant(w.db, w.tenant.id, (tx) =>
    tx
      .select({ action: auditEvents.action, objectType: auditEvents.objectType })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, w.tenant.id), eq(auditEvents.objectId, objectId))),
  );
}

describe('AC-DM-19 / B-67 预置项与自助子集', () => {
  it('新租户补装后三个字典各有预置编码，全部启用；自助子集编码都在预置里；重复补装不覆盖租户改名', async () => {
    const w = await exitWorld(testDb().db, 'seeds');
    for (const kind of EXIT_DICTIONARY_KINDS) {
      const codes = (await w.list(kind)).map((entry) => entry.code);
      expect(codes.sort()).toEqual(
        EXIT_DICTIONARY_PRESETS.filter((p) => p.kind === kind)
          .map((p) => p.code)
          .sort(),
      );
    }
    expect((await w.list('types')).every((entry) => entry.enabled)).toBe(true);
    const reasons = (await w.list('reasons')).map((entry) => entry.code);
    const whereabouts = (await w.list('whereabouts')).map((entry) => entry.code);
    expect(reasons).toEqual(expect.arrayContaining([...EXIT_SELF_REASON_CODES]));
    expect(whereabouts).toEqual(expect.arrayContaining([...EXIT_SELF_WHEREABOUTS_CODES]));

    const personal = (await w.list('reasons')).find((entry) => entry.code === 'personal')!;
    expect((await w.update('reasons', personal.id, personal.revision, { name: '租户改过的名称' })).status).toBe(200);
    const report = await installExitSeeds(w.db, w.tenant.id);
    expect(report).toEqual([
      expect.objectContaining({ module: 'employment', key: 'exit-dictionaries', installed: [], existing: 7 }),
    ]);
    expect((await w.list('reasons')).find((entry) => entry.code === 'personal')!.name).toBe('租户改过的名称');
  });

  it('字典按租户隔离：另一租户看不到本租户新增的项', async () => {
    const a = await exitWorld(testDb().db, 'iso-a');
    const b = await exitWorld(testDb().db, 'iso-b');
    await a.added('types', { code: 'only_a', name: '只属于 A' });
    expect((await b.list('types')).map((entry) => entry.code)).not.toContain('only_a');
    expect((await b.added('types', { code: 'only_a', name: 'B 也可用同编码' })).code).toBe('only_a');
  });
});

describe('AC-DM-19 / B-67 管理员维护字典', () => {
  it('新增 / 改名 / 停用 / 启用 / 调序；列表按显示顺序再按编码；enabled 筛选；每次写入 revision +1 并写配置审计', async () => {
    const w = await exitWorld(testDb().db, 'crud');
    const created = await w.added('types', { code: 'contract_end', name: '合同到期', displayOrder: 5 });
    expect(created).toMatchObject({
      code: 'contract_end',
      name: '合同到期',
      enabled: true,
      displayOrder: 5,
      revision: 1,
    });
    const defaulted = await w.added('reasons', { code: 'salary', name: '薪酬原因' });
    expect(defaulted).toMatchObject({ enabled: true, displayOrder: 0 });

    const renamed = await w.update('types', created.id, 1, { name: '劳动合同到期' });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: '劳动合同到期', displayOrder: 5, enabled: true, revision: 2 });
    const disabled = await w.update('types', created.id, 2, { enabled: false, displayOrder: 1 });
    expect(await disabled.json()).toMatchObject({ enabled: false, displayOrder: 1, revision: 3 });
    // 带上原编码（大小写一致）视为未改
    const same = await w.update('types', created.id, 3, { code: 'contract_end', name: '劳动合同到期' });
    expect(same.status).toBe(200);

    expect((await w.list('types', '?enabled=true')).map((e) => e.code)).not.toContain('contract_end');
    expect((await w.list('types', '?enabled=false')).map((e) => e.code)).toEqual(['contract_end']);
    const all = await w.list('types');
    expect(all.map((e) => [e.displayOrder, e.code])).toEqual(
      all
        .map((e) => [e.displayOrder, e.code])
        .toSorted((x, y) => +x[0]! - +y[0]! || String(x[1]).localeCompare(String(y[1]))),
    );
    const enabled = await w.update('types', created.id, 4, { enabled: true });
    expect(await enabled.json()).toMatchObject({ enabled: true, revision: 5 });

    const audits = await dictionaryAudits(w, created.id);
    expect(audits).toHaveLength(5);
    expect(audits.every((a) => a.action === 'exit_dictionary.save' && a.objectType === 'exit_dictionary')).toBe(true);
  });

  it('编码重复（不分大小写）409；改编码 400；revision 过期 409；均无写入', async () => {
    const w = await exitWorld(testDb().db, 'conflicts');
    const duplicate = await w.add('reasons', { code: 'PERSONAL', name: '大写重复' });
    expect(duplicate.status).toBe(409);
    expect(await reason(duplicate)).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'EXIT_DICTIONARY_CODE_TAKEN' },
    });
    const entry = await w.added('whereabouts', { code: 'abroad', name: '出国' });
    const recode = await w.update('whereabouts', entry.id, 1, { code: 'overseas', name: '出国' });
    expect(recode.status).toBe(400);
    expect(await reason(recode)).toMatchObject({ details: { reason: 'EXIT_DICTIONARY_CODE_IMMUTABLE' } });
    const stale = await w.update('whereabouts', entry.id, 9, { name: '出国深造' });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');
    const after = (await w.list('whereabouts')).find((e) => e.id === entry.id);
    expect(after).toMatchObject({ code: 'abroad', name: '出国', revision: 1 });
    expect((await w.list('reasons')).filter((e) => e.code.toLowerCase() === 'personal')).toHaveLength(1);
  });

  it('输入校验：未知字典、非 UUID、未知项、空名称、多余字段、新增 If-Match 非 0；不提供删除', async () => {
    const w = await exitWorld(testDb().db, 'validation');
    expect((await w.add('kinds', { code: 'x', name: 'x' })).status).toBe(400);
    expect((await w.request('GET', '/exits/dictionaries/kinds')).status).toBe(400);
    expect((await w.update('types', 'not-a-uuid', 1, { name: 'x' })).status).toBe(400);
    expect((await w.update('types', '00000000-0000-4000-8000-000000000000', 1, { name: 'x' })).status).toBe(404);
    expect((await w.add('types', { code: 'blank', name: '  ' })).status).toBe(400);
    expect((await w.add('types', { code: 'extra', name: '多余', kind: 'x' })).status).toBe(400);
    expect((await w.add('types', { code: 'rev', name: 'If-Match 非 0' }, { ifMatch: 3 })).status).toBe(409);
    const type = (await w.list('types'))[0]!;
    const removed = await w.request('DELETE', `/exits/dictionaries/types/${type.id}`, { ifMatch: type.revision });
    expect([404, 405]).toContain(removed.status);
    expect((await w.list('types')).map((e) => e.code).sort()).toEqual(['involuntary', 'voluntary']);
  });
});

describe('AC-DM-19 / B-67 停用项不可选，已保存单据仍显示名称', () => {
  it('停用后选择校验 400 EXIT_DICTIONARY_DISABLED、未知编码 400 EXIT_DICTIONARY_UNKNOWN；已保存单按编码取到名称', async () => {
    const w = await exitWorld(testDb().db, 'disabled');
    const { business } = await w.seedExitBusiness({ exitTypeCode: 'involuntary', reasonCode: 'family' });
    const involuntary = (await w.list('types')).find((e) => e.code === 'involuntary')!;
    expect((await w.update('types', involuntary.id, involuntary.revision, { enabled: false })).status).toBe(200);

    await withTenant(w.db, w.tenant.id, async (tx) => {
      await expect(assertExitDictionaryEnabled(tx, w.tenant.id, 'types', 'voluntary')).resolves.toBeUndefined();
      await expect(assertExitDictionaryEnabled(tx, w.tenant.id, 'types', 'INVOLUNTARY')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'EXIT_DICTIONARY_DISABLED', dictionary: 'types', code: 'INVOLUNTARY' },
      });
      await expect(assertExitDictionaryEnabled(tx, w.tenant.id, 'reasons', 'nope')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'EXIT_DICTIONARY_UNKNOWN' },
      });
      const [saved] = await tx
        .select({ code: exitRequests.exitTypeCode })
        .from(exitRequests)
        .where(and(eq(exitRequests.tenantId, w.tenant.id), eq(exitRequests.businessId, business.id)));
      const names = await exitDictionaryNames(tx, w.tenant.id, 'types', [saved!.code!, 'missing']);
      expect(Object.fromEntries(names)).toEqual({ involuntary: '被动离职' });
    });
  });
});

describe('AC-DM-19 / B-67 权限（真实授权器）', () => {
  it('管理员可写；只有任职记录查看权的成员可读不可写（403、无写入）；无查看权的成员读 403', async () => {
    const w = await exitWorld(testDb().db, 'auth');
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-01T01:00:00Z') });
    const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
    const seed = {
      db: w.db,
      tenant: w.tenant,
      admin: w.user,
      adminRecord,
      api,
      asAdmin: { tenant: w.tenant.id, user: w.user.id },
    };
    const viewer = await addMember(seed, '离职查看人');
    const stranger = await addMember(seed, '无权限成员');
    const profile = await createProfile(seed, 'exit-dictionary-viewer');
    const record = MODULE_OBJECTS.employmentRecord;
    const saved = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: record.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        buttons: [],
      },
      record.code,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
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
    const read = await as(viewer.id, 'GET', '/types');
    expect(read.status).toBe(200);
    expect(((await read.json()) as { items: { code: string }[] }).items.map((e) => e.code)).toContain('by_admin');
    expect((await as(viewer.id, 'POST', '/types', { code: 'by_viewer', name: '查看人新增' }, 0)).status).toBe(403);
    const id = ((await created.json()) as { id: string }).id;
    expect((await as(viewer.id, 'PUT', `/types/${id}`, { name: '查看人改名' }, 1)).status).toBe(403);
    expect((await as(stranger.id, 'GET', '/types')).status).toBe(403);
    const types = await w.list('types');
    expect(types.map((e) => e.code)).not.toContain('by_viewer');
    expect(types.find((e) => e.id === id)).toMatchObject({ name: '管理员新增', revision: 1 });
  });
});

describe('§2.2 转交时机配置项 exit.duty_transfer_timing', () => {
  it('系统值 business_effective；租户覆盖只接受两个取值', async () => {
    const w = await exitWorld(testDb().db, 'timing');
    const api = tenantApi(w.db);
    const at = { tenant: w.tenant.id, user: w.user.id };
    const read = await api.request('GET', '/api/tenant/settings/exit.duty_transfer_timing', at);
    expect(await read.json()).toMatchObject({ value: 'business_effective', source: 'system', revision: 0 });
    const invalid = await api.request('PUT', '/api/tenant/settings/exit.duty_transfer_timing', {
      ...at,
      ifMatch: 0,
      body: { value: 'immediately' },
    });
    expect(invalid.status).toBe(400);
    expect(await reason(invalid)).toMatchObject({ details: { reason: 'SETTING_VALUE_INVALID' } });
    const valid = await api.request('PUT', '/api/tenant/settings/exit.duty_transfer_timing', {
      ...at,
      ifMatch: 0,
      body: { value: 'approval_passed' },
    });
    expect(valid.status, await valid.clone().text()).toBe(200);
    expect(await valid.json()).toMatchObject({ value: 'approval_passed', source: 'tenant' });
  });
});
