/**
 * F-474-6c 第 2 轮返工验收（Codex 审查 942a21d4c 的 P2-2、P2-4）。作用对象：复刻系统（合成数据）。
 * 全部走真实授权器（world.api）：旧验收里“字段 ID 为 400”用放行授权器，掩盖了真实链路上先 403 的问题；
 * 旧前端读配置接口取定义，普通 HR（没有配置管理能力）得 403、字段整体消失。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addMember, seedPermissionWorld } from './AC-PRM-support.js';
import { define, fixture } from './AC-F474-6c-support.js';

const database = useTestDb();
const definitions = '/api/tenant/personnel/custom-field-definitions';
const configList = '/api/tenant/employment/custom-fields?objectType=personnel&page=1&pageSize=200';

describe('AC-F474-6c 第 2 轮：业务侧定义目录与写入校验顺序', () => {
  it('AC-F474-6c-R2-01 无配置管理能力的人员 HR 经业务侧目录读到有查看权的定义；未授权、他租户、非人员定义都不出现', async () => {
    const w = await fixture(database().db);
    const [viewOnly, editable, hidden] = [
      await define(w, 'text'),
      await define(w, 'select', []),
      await define(w, 'text'),
    ];
    const employment = await define(w, 'text', [], 'employment');
    const foreign = await seedPermissionWorld(database().db);
    const foreignId = await define(foreign, 'text');
    const hr = await w.actor('hr', [viewOnly, editable], [editable]);
    // 根因对照：配置接口要 admin.other_settings 一类的配置管理能力，普通人员 HR 读它得 403
    const config = await w.api.request('GET', configList, hr.as);
    expect(config.status).toBe(403);
    const res = await w.api.request('GET', definitions, hr.as);
    expect(res.status, await res.clone().text()).toBe(200);
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items.map((item) => item.id).sort()).toEqual([viewOnly, editable].sort());
    const byId = Object.fromEntries(items.map((item) => [item.id as string, item]));
    expect(byId[viewOnly]).toMatchObject({ valueType: 'text', editable: false });
    expect(byId[editable]).toMatchObject({ valueType: 'select', editable: true, options: [] });
    // 只给展示所需的最小字段：不含编码、继承、版本号等配置信息
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual(['editable', 'id', 'name', 'options', 'valueType']);
    const raw = JSON.stringify(items);
    for (const other of [hidden, employment, foreignId]) expect(raw).not.toContain(other);
    // 同一身份在详情里读到该字段的值，两条读路径用同一套 custom:<id> 权限
    const writer = await w.actor('writer', [viewOnly], [viewOnly]);
    expect((await w.patch(writer.as, { customFields: { [viewOnly]: '合成值' } })).status).toBe(200);
    expect((await w.read(hr.as)).customFields).toEqual({ [viewOnly]: '合成值' });
  });

  it('AC-F474-6c-R2-02 有人员对象查看权但没有任何 custom:<id> 查看权：200 且目录为空', async () => {
    const w = await fixture(database().db);
    await define(w, 'text');
    const plain = await w.actor('plain', [], []);
    const res = await w.api.request('GET', definitions, plain.as);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ items: [] });
  });

  it('AC-F474-6c-R2-03 没有人员对象查看权：目录 403，不泄露定义', async () => {
    const w = await fixture(database().db);
    const id = await define(w, 'text');
    const nobody = await addMember(w, 'nobody');
    const res = await w.api.request('GET', definitions, { tenant: w.tenant.id, user: nobody.id });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(await res.clone().text()).not.toContain(id);
  });

  it('AC-F474-6c-R2-04 真实授权器下：未知、他租户、非人员对象的字段 ID 一律 400，不落版本也不写审计', async () => {
    const w = await fixture(database().db);
    const own = await define(w, 'text');
    const foreign = await seedPermissionWorld(database().db);
    const foreignId = await define(foreign, 'text');
    const employmentId = await define(w, 'text', [], 'employment');
    const writer = await w.actor('writer', [own], [own]);
    const before = await w.stored();
    for (const id of [randomUUID(), foreignId, employmentId]) {
      const alone = await w.patch(writer.as, { customFields: { [id]: 'x' } });
      expect(alone.status, await alone.clone().text()).toBe(400);
      expect((await alone.json()).error.code).toBe('VALIDATION_FAILED');
      // 合法字段与非法 ID 混在一起：整单拒绝，合法字段也不写
      const mixed = await w.patch(writer.as, { customFields: { [own]: '合成值', [id]: 'x' } });
      expect(mixed.status, await mixed.clone().text()).toBe(400);
    }
    const after = await w.stored();
    expect(after.versions.length).toBe(before.versions.length);
    expect(after.audits.length).toBe(before.audits.length);
    // 对照：同一身份写自己有编辑权的合法字段是 200
    expect((await w.patch(writer.as, { customFields: { [own]: '合成值' } })).status).toBe(200);
  });

  it('AC-F474-6c-R2-05 校验顺序：对象权限与人员范围在前，合法定义但无编辑权仍 403，非法 ID 先于逐字段编辑权', async () => {
    const w = await fixture(database().db);
    const [a, b] = [await define(w, 'text'), await define(w, 'text')];
    const reader = await w.actor('reader', [a, b], [a]);
    const nobody = await addMember(w, 'nobody');
    const before = await w.stored();
    // 合法定义但没有该字段的编辑权：403
    expect((await w.patch(reader.as, { customFields: { [b]: 'x' } })).status).toBe(403);
    // 非法 ID 在逐字段编辑权之前判定：同一身份提交未知 ID 得 400，而不是 403
    expect((await w.patch(reader.as, { customFields: { [randomUUID()]: 'x' } })).status).toBe(400);
    // 没有人员对象编辑权的成员：即便提交非法 ID 也先被对象权限拒绝，不能借 400 探测定义是否存在
    const denied = await w.api.request('PATCH', w.path, {
      tenant: w.tenant.id,
      user: nobody.id,
      ifMatch: (await w.read(reader.as)).revision,
      body: { customFields: { [randomUUID()]: 'x' } },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
    const after = await w.stored();
    expect(after.versions.length).toBe(before.versions.length);
    expect(after.audits.length).toBe(before.audits.length);
  });
});
