/**
 * F-474-6b 组织自定义字段：写入侧（docs/08_设计/F-474-6a §3.2、§5、§7）。
 * 真实授权器 + 真实迁移后的库（PGlite；PG 分片同跑）。AC-F474-6b-xx 对应设计 AC-CF-xx，映射见 PR 描述。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resolveCustomFields } from '../../apps/api/src/modules/org/custom-fields.js';
import { resultRows } from './AC-ORG-support.js';
import { AT, customFieldWorld, type CustomFieldWorld, type OrgDto } from './support/f474-6b-world.js';

const database = useTestDb();
const east = { value: 'east', label: '合成东区', enabled: true };
const west = { value: 'west', label: '合成西区', enabled: false };

async function versions(w: CustomFieldWorld, orgId: string) {
  return withTenant(database().db, w.world.tenant.id, async (tx) =>
    resultRows<{ version_no: number; start_date: string; custom_fields: Record<string, unknown> }>(
      await tx.execute(sql`SELECT version_no, start_date::text, custom_fields FROM org_versions
        WHERE org_id=${orgId} ORDER BY version_no`),
    ),
  );
}
const patch = (
  op: Awaited<ReturnType<CustomFieldWorld['operator']>>,
  org: OrgDto,
  body: object,
  effectiveDate = AT,
  ifMatch = org.revision,
) => op.request('PATCH', `/organizations/${org.id}`, { ifMatch, body: { effectiveDate, ...body } });

describe('AC-F474-6b 组织自定义字段写入', () => {
  it('AC-F474-6b-01 有编辑权的操作人新建组织带自定义字段，值写入首个版本并按字段 ID 返回', async () => {
    const w = await customFieldWorld(database().db);
    const text = await w.define('合成文本');
    const top = await w.top();
    const op = await w.operator(top.id, { [text.id]: 'edit' });
    const created = await op.request('POST', '/organizations', {
      ifMatch: 0,
      body: {
        name: `合成组织${w.suffix}`,
        establishedOn: '2000-01-01',
        parents: { admin: { parentId: top.id } },
        customFields: { [text.id]: '成本中心 A' },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const body = (await created.json()) as OrgDto;
    expect(body.customFields).toEqual({ [text.id]: '成本中心 A' });
    expect((await versions(w, body.id)).map((row) => row.custom_fields)).toEqual([{ [text.id]: '成本中心 A' }]);
  });

  it('AC-F474-6b-02 写入 fail-closed：仅查看或无权的字段整单 403，授编辑后可写；不放行部分字段', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成可编辑');
    const b = await w.define('合成仅查看');
    const c = await w.define('合成无权');
    const top = await w.top();
    const org = await w.seedOrg('待改组织', top.id);
    const op = await w.operator(top.id, { [a.id]: 'edit', [b.id]: 'view' });
    for (const body of [
      { [b.id]: 'x' },
      { [c.id]: 'x' },
      { [a.id]: 'ok', [b.id]: 'x' },
      { [a.id]: 'ok', [c.id]: 'x' },
    ]) {
      const denied = await patch(op, org, { customFields: body });
      expect(denied.status, JSON.stringify(body)).toBe(403);
    }
    const create = await op.request('POST', '/organizations', {
      ifMatch: 0,
      body: {
        name: `被拒新建${w.suffix}`,
        parents: { admin: { parentId: top.id } },
        customFields: { [c.id]: 'x' },
      },
    });
    expect(create.status).toBe(403);
    expect((await versions(w, org.id)).map((row) => row.custom_fields)).toEqual([{}]);
    const ok = await patch(op, org, { customFields: { [a.id]: 'ok' } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await versions(w, org.id)).map((row) => row.custom_fields)).toEqual([{}, { [a.id]: 'ok' }]);
    // 授予编辑后下一次请求即可写（权限撤销 / 追加不缓存）
    await op.regrant({ [a.id]: 'edit', [b.id]: 'edit' });
    const org2 = (await (await op.request('GET', `/organizations/${org.id}?asOf=${AT}`)).json()) as OrgDto;
    expect((await patch(op, org2, { customFields: { [b.id]: 'y' } }, '2026-10-02')).status).toBe(200);
  });

  it('AC-F474-6b-03 租户隔离：他租户 / 未知字段 ID 不能写入（路由 403，定义校验 400），版本行不带该键', async () => {
    const w = await customFieldWorld(database().db);
    const other = await customFieldWorld(database().db);
    const mine = await w.define('合成本租户');
    const foreign = await other.define('合成外租户');
    const top = await w.top();
    const org = await w.seedOrg('隔离组织', top.id);
    const op = await w.operator(top.id, { [mine.id]: 'edit' });
    const unknownId = '00000000-0000-4000-8000-000000000001';
    // 真实授权器：字段目录里没有的编码一律 403（先于定义校验，不区分“他租户的”和“不存在的”，不泄露存在性）；
    // 全放行视角越过字段权限后，定义校验同样 400 拒绝。
    for (const id of [foreign.id, unknownId]) {
      expect((await patch(op, org, { customFields: { [id]: 'x' } })).status, id).toBe(403);
      const viaAdmin = await w.admin('PATCH', `/organizations/${org.id}`, {
        ifMatch: org.revision,
        body: { effectiveDate: AT, customFields: { [id]: 1 } },
      });
      expect(viaAdmin.status, id).toBe(400);
    }
    expect((await versions(w, org.id)).map((row) => row.custom_fields)).toEqual([{}]);
    // 纵深防御：权限通过后的定义校验也只认本租户的组织字段，他租户 / 未知 ID 直接 400
    for (const id of [foreign.id, unknownId]) {
      const attempt = withTenant(database().db, w.world.tenant.id, (tx) =>
        resolveCustomFields(tx, w.world.tenant.id, {}, { [id]: 'x' }),
      );
      await expect(attempt, id).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    const own = await withTenant(database().db, w.world.tenant.id, (tx) =>
      resolveCustomFields(tx, w.world.tenant.id, {}, { [mine.id]: 'ok' }),
    );
    expect(own).toEqual({ [mine.id]: 'ok' });
  });

  it('AC-F474-6b-04 版本链：每次改动追加新版本，上一版本值不变；未提交的字段带上一版本；null 清空', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成甲');
    const b = await w.define('合成乙');
    const top = await w.top();
    const org = await w.seedOrg('版本组织', top.id);
    const op = await w.operator(top.id, { [a.id]: 'edit', [b.id]: 'edit' });
    const first = await patch(op, org, { customFields: { [a.id]: 'v1', [b.id]: 'b1' } });
    expect(first.status, await first.clone().text()).toBe(200);
    const one = (await first.json()) as OrgDto;
    const second = await patch(op, one, { customFields: { [a.id]: 'v2' } }, '2026-10-02');
    expect(second.status).toBe(200);
    const two = (await second.json()) as OrgDto;
    expect(two.customFields).toEqual({ [a.id]: 'v2', [b.id]: 'b1' });
    // 只改名称：自定义字段整体带上一版本
    const third = await patch(op, two, { name: `改名后${w.suffix}`, addEmployment: false }, '2026-10-03');
    expect(third.status, await third.clone().text()).toBe(200);
    const three = (await third.json()) as OrgDto;
    expect(three.customFields).toEqual({ [a.id]: 'v2', [b.id]: 'b1' });
    const fourth = await patch(op, three, { customFields: { [b.id]: null } }, '2026-10-04');
    expect(fourth.status).toBe(200);
    expect(((await fourth.json()) as OrgDto).customFields).toEqual({ [a.id]: 'v2' });
    const rows = await versions(w, org.id);
    expect(rows.map((row) => [row.version_no, row.custom_fields])).toEqual([
      [1, {}],
      [2, { [a.id]: 'v1', [b.id]: 'b1' }],
      [3, { [a.id]: 'v2', [b.id]: 'b1' }],
      [4, { [a.id]: 'v2', [b.id]: 'b1' }],
      [5, { [a.id]: 'v2' }],
    ]);
    // 没有单独的“变更前”列（硬规则）
    const columns = await withTenant(database().db, w.world.tenant.id, async (tx) =>
      resultRows<{ column_name: string }>(
        await tx.execute(sql`SELECT column_name FROM information_schema.columns
          WHERE table_name='org_versions' AND column_name ILIKE '%custom%'`),
      ),
    );
    expect(columns).toEqual([{ column_name: 'custom_fields' }]);
  });

  it('AC-F474-6b-05 值校验：类型、长度、日期、下拉选项集；非法一律 400 且不写版本', async () => {
    const w = await customFieldWorld(database().db);
    const text = await w.define('合成文本');
    const integer = await w.define('合成整数', 'integer');
    const decimal = await w.define('合成小数', 'decimal');
    const flag = await w.define('合成布尔', 'boolean');
    const day = await w.define('合成日期', 'date');
    const pick = await w.define('合成下拉', 'select', [east]);
    const top = await w.top();
    const org = await w.seedOrg('校验组织', top.id);
    const modes = Object.fromEntries([text, integer, decimal, flag, day, pick].map((d) => [d.id, 'edit' as const]));
    const op = await w.operator(top.id, modes);
    const bad: [string, unknown][] = [
      [text.id, 'x'.repeat(2001)],
      [text.id, 5],
      [integer.id, 1.5],
      [integer.id, 'abc'],
      [decimal.id, 'abc'],
      [flag.id, 'yes'],
      [day.id, '2026-13-40'],
      [day.id, '2026/10/01'],
      [pick.id, 'north'],
      [pick.id, 1],
    ];
    for (const [id, value] of bad) {
      const response = await patch(op, org, { customFields: { [id]: value } });
      expect(response.status, `${id} ${String(value)}`).toBe(400);
    }
    for (const value of [
      [[], 400],
      ['x', 400],
    ] as const) {
      const response = await patch(op, org, { customFields: value[0] });
      expect(response.status).toBe(value[1]);
    }
    expect((await versions(w, org.id)).length).toBe(1);
    const good = {
      [text.id]: 'x'.repeat(2000),
      [integer.id]: 7,
      [decimal.id]: 1.25,
      [flag.id]: false,
      [day.id]: '2026-10-01',
      [pick.id]: 'east',
    };
    const saved = await patch(op, org, { customFields: good });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as OrgDto).customFields).toEqual(good);
  });

  it('AC-F474-6b-06 停用的下拉选项不能新选，但历史值仍可保留、可读；非本字段选项报 400', async () => {
    const w = await customFieldWorld(database().db);
    const pick = await w.define('合成下拉', 'select', [east, { ...west, enabled: true }]);
    const top = await w.top();
    const org = await w.seedOrg('下拉组织', top.id);
    const op = await w.operator(top.id, { [pick.id]: 'edit' });
    const chosen = await patch(op, org, { customFields: { [pick.id]: 'west' } });
    expect(chosen.status).toBe(200);
    const disabled = await w.world.api.request('PUT', `/api/tenant/employment/custom-fields/${pick.id}/options`, {
      ...w.world.asAdmin,
      ifMatch: pick.revision,
      body: { options: [east, west] },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const current = (await chosen.json()) as OrgDto;
    // 重新提交已存的停用选项：放行；新选另一个停用项 / 未知项：拒绝
    const retained = await patch(op, current, { customFields: { [pick.id]: 'west' } }, '2026-10-02');
    expect(retained.status, await retained.clone().text()).toBe(200);
    const next = (await retained.json()) as OrgDto;
    const switched = await patch(op, next, { customFields: { [pick.id]: 'east' } }, '2026-10-03');
    expect(switched.status).toBe(200);
    const back = (await switched.json()) as OrgDto;
    const again = await patch(op, back, { customFields: { [pick.id]: 'west' } }, '2026-10-04');
    expect(again.status, '已离开的停用项不能重新选择').toBe(400);
  });

  it('AC-F474-6b-07 预检（validate）与新建、更新共用同一校验；customFields 之外的未知键仍被拒', async () => {
    const w = await customFieldWorld(database().db);
    const text = await w.define('合成文本');
    const top = await w.top();
    const op = await w.operator(top.id, { [text.id]: 'edit' });
    const base = { name: `预检${w.suffix}`, parents: { admin: { parentId: top.id } } };
    const bad = await op.request('POST', '/validate', { body: { ...base, customFields: { [text.id]: 5 } } });
    expect(bad.status, await bad.clone().text()).toBe(400);
    const good = await op.request('POST', '/validate', { body: { ...base, customFields: { [text.id]: 'ok' } } });
    expect(good.status, await good.clone().text()).toBe(200);
    for (const body of [
      { ...base, surprise: 1 },
      { ...base, customFields: { [text.id]: 'ok' }, surprise: 1 },
    ]) {
      expect((await op.request('POST', '/organizations', { ifMatch: 0, body })).status).toBe(400);
    }
  });

  it('AC-F474-6b-08 级联停用的下级版本保留各自的自定义字段', async () => {
    const w = await customFieldWorld(database().db);
    const text = await w.define('合成文本');
    const top = await w.top();
    const parent = await w.seedOrg('上级', top.id);
    const child = await w.seedOrg('下级', parent.id);
    const op = await w.operator(top.id, { [text.id]: 'edit' });
    expect((await patch(op, child, { customFields: { [text.id]: '下级值' } })).status).toBe(200);
    const stop = await patch(op, parent, { enabled: false }, '2026-10-05');
    expect(stop.status, await stop.clone().text()).toBe(200);
    const rows = await versions(w, child.id);
    expect(rows.at(-1)?.custom_fields).toEqual({ [text.id]: '下级值' });
    expect(rows.length).toBe(3);
  });
});
