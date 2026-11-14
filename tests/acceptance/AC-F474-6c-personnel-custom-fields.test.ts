/**
 * F-474-6c 人员自定义字段（设计 docs/08_设计/F-474-6a §7 AC-CF-02..07、10、11 落到人员对象）。
 * 作用对象：复刻系统（合成数据）。全部走真实授权器（world.api）；只有“跨租户字段 ID 为 400”这条用放行授权器，
 * 因为真实授权器会先以“字段未登记”拒绝（403），到不了定义校验。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { visibleValue } from '../../apps/api/src/audit/visibility.js';
import { PERSONNEL_POLICIES } from '../../apps/api/src/modules/personnel/policy.js';
import { base, define, fixture, key } from './AC-F474-6c-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';

const database = useTestDb();
const east = { value: 'east', label: '合成东区', enabled: true };
const west = { value: 'west', label: '合成西区', enabled: true };
const old = { value: 'old', label: '合成旧区', enabled: false };

describe('AC-F474-6c 人员自定义字段', () => {
  it('AC-F474-6c-01 迁移：列默认空对象，非对象值被检查约束拒绝，历史行不回填', async () => {
    const w = await fixture(database().db);
    const writer = await w.actor('writer', [], []);
    await w.patch(writer.as, { name: '合成改名' });
    const { versions } = await w.stored();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((v) => (v as { customFields?: unknown }).customFields !== undefined)).toBe(true);
    expect((versions.at(-1) as { customFields: unknown }).customFields).toEqual({});
    // 版本表只追加（不授 UPDATE），约束以目录为准：必须存在且限定为对象
    const found = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname='personnel_employee_custom_fields_object'`),
    );
    expect(JSON.stringify(found)).toContain("jsonb_typeof(custom_fields) = 'object'");
  });

  it('AC-F474-6c-02 新定义对任何身份默认不可见；授权后才出现在详情、列表和历史里，无权者连键都没有', async () => {
    const w = await fixture(database().db);
    const field = await define(w, 'text');
    const other = await define(w, 'text');
    const writer = await w.actor('writer', [field], [field]);
    const reader = await w.actor('reader', [field], []);
    const hidden = await w.actor('hidden', [], []);
    const first = await w.patch(writer.as, { customFields: { [field]: '合成值甲' } });
    expect(first.status, await first.clone().text()).toBe(200);
    expect((await first.json()).customFields).toEqual({ [field]: '合成值甲' });
    // reader 能看，但看不到未授权的 other；hidden 的响应里没有 customFields 键，也不含值
    expect((await w.read(reader.as)).customFields).toEqual({ [field]: '合成值甲' });
    const unseen = await w.read(hidden.as);
    expect(Object.hasOwn(unseen, 'customFields')).toBe(false);
    expect(JSON.stringify(unseen)).not.toContain('合成值甲');
    expect(JSON.stringify(await w.read(reader.as))).not.toContain(other);
    for (const [as, visible] of [
      [reader.as, true],
      [hidden.as, false],
    ] as const) {
      const list = await w.api.request('GET', `${base}?page=1&pageSize=15`, as);
      expect(list.status).toBe(200);
      const item = (await list.json()).items.find((row: { id: string }) => row.id === w.employee.id);
      expect(item && Object.hasOwn(item, 'customFields')).toBe(visible);
      const history = await w.api.request('GET', `${path(w)}/history`, as);
      expect(history.status).toBe(200);
      const raw = JSON.stringify(await history.json());
      expect(raw.includes('合成值甲')).toBe(visible);
    }
  });

  it('AC-F474-6c-03 只有查看权提交 403，未授权字段 403，授权可编辑字段 200，失败不产生新版本', async () => {
    const w = await fixture(database().db);
    const [a, b] = [await define(w, 'text'), await define(w, 'text')];
    const writer = await w.actor('writer', [a, b], [a]);
    const reader = await w.actor('reader', [a], []);
    const before = (await w.stored()).versions.length;
    expect((await w.patch(reader.as, { customFields: { [a]: 'x' } })).status).toBe(403);
    expect((await w.patch(writer.as, { customFields: { [b]: 'x' } })).status).toBe(403);
    expect((await w.patch(writer.as, { customFields: { [a]: 'ok', [b]: 'x' } })).status).toBe(403);
    expect((await w.stored()).versions.length).toBe(before);
    const ok = await w.patch(writer.as, { customFields: { [a]: 'ok' } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.stored()).versions.length).toBe(before + 1);
  });

  it('AC-F474-6c-04 字段 ID 必须是本租户人员定义：未知、他租户、非人员对象一律 400', async () => {
    const w = await fixture(database().db);
    const foreign = await seedPermissionWorld(database().db);
    const foreignId = await define(foreign, 'text');
    const employmentId = await define(w, 'text', [], 'employment');
    const before = (await w.stored()).versions.length;
    const current = await w.setup.request('GET', w.path, w.asAdmin);
    const { revision } = (await current.json()) as { revision: number };
    for (const id of [randomUUID(), foreignId, employmentId]) {
      const res = await w.setup.request('PATCH', w.path, {
        ...w.asAdmin,
        ifMatch: revision,
        body: { customFields: { [id]: 'x' } },
      });
      expect(res.status, await res.clone().text()).toBe(400);
    }
    expect((await w.stored()).versions.length).toBe(before);
    // 对照：本租户的人员定义同样走放行授权器，必须写成功，说明上面的 400 来自定义校验而不是请求体被整体拒绝
    const own = await define(w, 'text');
    const ok = await w.setup.request('PATCH', w.path, {
      ...w.asAdmin,
      ifMatch: revision,
      body: { customFields: { [own]: 'x' } },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('AC-F474-6c-05 版本链：每次写入新增一条版本，未提交的字段沿用上一版，审计的“变更前”取上一版', async () => {
    const w = await fixture(database().db);
    const [a, b] = [await define(w, 'text'), await define(w, 'integer')];
    const writer = await w.actor('writer', [a, b], [a, b]);
    expect((await w.patch(writer.as, { customFields: { [a]: '甲', [b]: 1 } })).status).toBe(200);
    expect((await w.patch(writer.as, { customFields: { [b]: 2 } })).status).toBe(200);
    // 只改预置字段，自定义值整体沿用
    expect((await w.patch(writer.as, { name: '合成改名二' })).status).toBe(200);
    const { versions, audits } = await w.stored();
    const mine = versions.filter((v) => v.revision >= 1);
    const custom = mine.map((v) => (v as { customFields: unknown }).customFields);
    expect(custom.slice(-3)).toEqual([
      { [a]: '甲', [b]: 1 },
      { [a]: '甲', [b]: 2 },
      { [a]: '甲', [b]: 2 },
    ]);
    expect(new Set(mine.map((v) => v.revision)).size).toBe(mine.length);
    // 第二次写入：审计只记变化的 id，前值取上一版
    const second = audits.find(
      (row) =>
        JSON.stringify(row.after ?? {}).includes('"customFields"') &&
        row.before &&
        JSON.stringify(row.before).includes(`"${b}":1`),
    );
    expect(second?.before).toEqual({ customFields: { [b]: 1 } });
    expect(second?.after).toEqual({ customFields: { [b]: 2 } });
    // 与业务写入同一命令：审计的命令号等于版本行的命令号
    const row = versions.at(-2) as { commandId: string };
    expect(audits.some((event) => event.commandId === row.commandId)).toBe(true);
  });

  it('AC-F474-6c-06 值校验：类型、2000 字、选项集合、停用选项只可沿用，null 清空', async () => {
    const w = await fixture(database().db);
    const ids = {
      text: await define(w, 'text'),
      integer: await define(w, 'integer'),
      decimal: await define(w, 'decimal'),
      boolean: await define(w, 'boolean'),
      date: await define(w, 'date'),
      select: await define(w, 'select', [east, west, old]),
    };
    const all = Object.values(ids);
    const writer = await w.actor('writer', all, all);
    const send = async (id: string, value: unknown) =>
      (await w.patch(writer.as, { customFields: { [id]: value } })).status;
    expect(await send(ids.text, 'a'.repeat(2001))).toBe(400);
    expect(await send(ids.text, 7)).toBe(400);
    expect(await send(ids.integer, 1.5)).toBe(400);
    expect(await send(ids.decimal, 'x')).toBe(400);
    expect(await send(ids.boolean, 'true')).toBe(400);
    expect(await send(ids.date, '2026-02-30')).toBe(400);
    expect(await send(ids.select, 'missing')).toBe(400);
    expect(await send(ids.select, 'old')).toBe(400);
    for (const [id, value] of [
      [ids.text, 'a'.repeat(2000)],
      [ids.integer, 3],
      [ids.decimal, 1.25],
      [ids.boolean, false],
      [ids.date, '2026-02-28'],
      [ids.select, 'east'],
    ] as const)
      expect(await send(id, value)).toBe(200);
    // 历史值是后来被停用的选项：可读、可原样提交；换成其他值后不能再选回
    expect(await send(ids.select, 'old')).toBe(400);
    expect(await send(ids.select, 'east')).toBe(200);
    const enabled = [east, west, { ...old, enabled: true }];
    const open = await w.setup.request('PUT', `/api/tenant/employment/custom-fields/${ids.select}/options`, {
      ...w.asAdmin,
      ifMatch: 1,
      body: { options: enabled },
    });
    expect(open.status, await open.clone().text()).toBe(200);
    expect(await send(ids.select, 'old')).toBe(200);
    const close = await w.setup.request('PUT', `/api/tenant/employment/custom-fields/${ids.select}/options`, {
      ...w.asAdmin,
      ifMatch: 2,
      body: { options: [east, west, old] },
    });
    expect(close.status, await close.clone().text()).toBe(200);
    expect((await w.read(writer.as)).customFields).toMatchObject({ [ids.select]: 'old' });
    expect(await send(ids.select, 'old')).toBe(200);
    expect(await send(ids.select, 'west')).toBe(200);
    expect(await send(ids.select, 'old')).toBe(400);
    expect(await send(ids.text, null)).toBe(200);
    expect(((await w.read(writer.as)).customFields as Record<string, unknown>)[ids.text]).toBeNull();
  });

  it('AC-F474-6c-07 选项改名后值按稳定编码跟随，不改写人员历史', async () => {
    const w = await fixture(database().db);
    const select = await define(w, 'select', [east]);
    const writer = await w.actor('writer', [select], [select]);
    expect((await w.patch(writer.as, { customFields: { [select]: 'east' } })).status).toBe(200);
    const renamed = await w.setup.request('PUT', `/api/tenant/employment/custom-fields/${select}/options`, {
      ...w.asAdmin,
      ifMatch: 1,
      body: { options: [{ ...east, label: '合成新东区' }, west] },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect((await w.read(writer.as)).customFields).toEqual({ [select]: 'east' });
    const { versions } = await w.stored();
    expect((versions.at(-1) as { customFields: unknown }).customFields).toEqual({ [select]: 'east' });
  });

  it('AC-F474-6c-08 撤权后详情、列表、历史版本一并裁掉；撤销身份不删值，重新授权后可见', async () => {
    const w = await fixture(database().db);
    const field = await define(w, 'text');
    const writer = await w.actor('writer', [field], [field]);
    const reader = await w.actor('reader', [field], []);
    expect((await w.patch(writer.as, { customFields: { [field]: '合成秘密值' } })).status).toBe(200);
    expect((await w.patch(writer.as, { customFields: { [field]: '合成秘密值二' } })).status).toBe(200);
    await reader.configure([], []);
    const detail = await w.read(reader.as);
    expect(Object.hasOwn(detail, 'customFields')).toBe(false);
    const history = await w.api.request('GET', `${path(w)}/history`, reader.as);
    expect(JSON.stringify(await history.json())).not.toContain('合成秘密值');
    const list = await w.api.request('GET', `${base}?page=1&pageSize=15`, reader.as);
    expect(JSON.stringify(await list.json())).not.toContain('合成秘密值');
    await reader.configure([field], []);
    expect((await w.read(reader.as)).customFields).toEqual({ [field]: '合成秘密值二' });
  });

  it('AC-F474-6c-09 审计与业务同事务，值按字段权限裁剪（以真实审计行为夹具）', async () => {
    const w = await fixture(database().db);
    const [a, b] = [await define(w, 'text'), await define(w, 'text')];
    const writer = await w.actor('writer', [a, b], [a, b]);
    expect((await w.patch(writer.as, { customFields: { [a]: '甲', [b]: '乙' } })).status).toBe(200);
    const { audits } = await w.stored();
    const event = audits.find((row) => JSON.stringify(row.after ?? {}).includes('"customFields"'))!;
    expect((event.after as Record<string, unknown>).customFields).toEqual({ [a]: '甲', [b]: '乙' });
    expect((event.before as Record<string, unknown>).customFields).toEqual({ [a]: null, [b]: null });
    const visible = new Set([key(a)]);
    expect(visibleValue(event.after, visible)).toEqual({ customFields: { [a]: '甲' } });
    expect(visibleValue(event.after, new Set())).not.toHaveProperty('customFields');
  });

  it('AC-F474-6c-10 单次写入失败（版本冲突）不留下版本与审计', async () => {
    const w = await fixture(database().db);
    const field = await define(w, 'text');
    const writer = await w.actor('writer', [field], [field]);
    const before = await w.stored();
    const res = await w.patch(writer.as, { customFields: { [field]: 'x' } }, 99);
    expect(res.status).toBe(409);
    const after = await w.stored();
    expect(after.versions.length).toBe(before.versions.length);
    expect(after.audits.length).toBe(before.audits.length);
  });

  it('AC-F474-6c-11 F-039：人员写路由的字段来源含 customFields，其余人员写路由不变', () => {
    const hit = PERSONNEL_POLICIES.lookup('PATCH /api/tenant/personnel/employees/:id');
    const policy = hit?.policy as { write?: { fields?: unknown } } | undefined;
    expect(policy?.write?.fields).toBe('body+customFields');
  });
});

function path(w: { path: string }) {
  return w.path;
}
