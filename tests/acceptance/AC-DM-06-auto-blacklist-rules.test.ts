/**
 * AC-DM-06（配置部分，B68）：离职自动加黑规则页（差距表“补证结论 R2f”、DEC-569）。
 * 总开关“离职后自动加入黑名单”（两层配置，系统值关闭）；规则增删改查：规则信息（名称*、优先级*、适用组织*、规则说明 0/500）、
 * 加黑条件（只实现“离职次数 大于等于 N 次”）、加黑信息（期限* 永久 / 离职当月、原因*、说明 0/500）。
 * 其他条件字段、其他运算符、“指定期限”未验证：接口拒绝（后补）。自动加黑的实际执行归 BE-8b，这里只验证规则服务可供调用。
 */
import { withTenant } from '@italent/db';
import { matchBlacklistRule } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import type * as RuleService from '../../apps/api/src/modules/employment/blacklist-rules.js';

const testDb = useTestDb();
const SERVICE = '../../apps/api/src/modules/employment/blacklist-rules.js';
const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;

interface Rule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly description: string | null;
  readonly conditions: { field: string; operator: string; value: number }[];
  readonly term: string;
  readonly reason: string;
  readonly note: string | null;
  readonly revision: number;
}

async function rulesWorld(label: string) {
  const db = testDb().db;
  const session = await employmentSession(db, `auto-blacklist-${label}`);
  const org = await session.org(`规则组织-${label}`, { establishedOn: '2025-01-01' });
  const body = (extra: Record<string, unknown> = {}) => ({
    name: '离职三次永久',
    priority: 1,
    orgIds: [org.id],
    description: '合成规则说明',
    conditions: [{ field: 'exitCount', operator: 'gte', value: 3 }],
    term: 'permanent',
    reason: 'instability',
    note: '合成加黑说明',
    ...extra,
  });
  const create = (value: unknown, ifMatch = 0) => session.request('POST', '/blacklist-rules', { ifMatch, body: value });
  const update = (id: string, revision: number, value: unknown) =>
    session.request('PUT', `/blacklist-rules/${id}`, { ifMatch: revision, body: value });
  const remove = (id: string, revision: number) =>
    session.request('DELETE', `/blacklist-rules/${id}`, { ifMatch: revision });
  async function list(): Promise<Rule[]> {
    const response = await session.request('GET', '/blacklist-rules');
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Rule[] }).items;
  }
  async function created(value: unknown): Promise<Rule> {
    const response = await create(value);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Rule;
  }
  return { db, session, org, body, create, update, remove, list, created };
}

describe('AC-DM-06 总开关“离职后自动加入黑名单”', () => {
  it('系统值 false；租户覆盖只接受布尔值', async () => {
    const { db, session } = await rulesWorld('switch');
    const api = tenantApi(db);
    const as = { tenant: session.tenant.id, user: session.user.id };
    const read = await api.request('GET', '/api/tenant/settings/exit.auto_blacklist_enabled', as);
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.json()).toMatchObject({ value: false, source: 'system', revision: 0 });
    const put = (value: unknown, ifMatch: number) =>
      api.request('PUT', '/api/tenant/settings/exit.auto_blacklist_enabled', { ...as, ifMatch, body: { value } });
    const invalid = await put('yes', 0);
    expect(invalid.status).toBe(400);
    expect((await error(invalid)).details).toMatchObject({ reason: 'SETTING_VALUE_INVALID' });
    expect(await (await put(true, 0)).json()).toMatchObject({ value: true, source: 'tenant', revision: 1 });
  });
});

describe('AC-DM-06 规则增删改查', () => {
  it('新增 / 编辑 / 删除：按优先级再按创建顺序排列；每次写入 revision +1 并写配置审计', async () => {
    const w = await rulesWorld('crud');
    const third = await w.created(w.body());
    expect(third).toMatchObject({
      name: '离职三次永久',
      priority: 1,
      orgIds: [w.org.id],
      conditions: [{ field: 'exitCount', operator: 'gte', value: 3 }],
      term: 'permanent',
      reason: 'instability',
      revision: 1,
    });
    const every = await w.created(
      w.body({
        name: '离职即当月',
        priority: 0,
        description: null,
        note: null,
        conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }],
        term: 'exit_month',
        reason: 'other',
      }),
    );
    expect((await w.list()).map((r) => r.id)).toEqual([every.id, third.id]);
    const saved = await w.update(third.id, 1, w.body({ priority: 5, name: '离职三次永久（改）' }));
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ priority: 5, name: '离职三次永久（改）', revision: 2 });
    expect((await w.update(third.id, 1, w.body())).status).toBe(409);
    expect((await w.remove(every.id, 9)).status).toBe(409);
    const removed = await w.remove(every.id, 1);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.list()).map((r) => r.id)).toEqual([third.id]);
    expect((await w.remove(every.id, 1)).status).toBe(404);
  });

  it('未验证的条件字段 / 运算符 / 期限与非法输入 400，均不写入', async () => {
    const w = await rulesWorld('invalid');
    const cases: Record<string, unknown>[] = [
      { conditions: [{ field: 'assessmentResult', operator: 'gte', value: 1 }] },
      { conditions: [{ field: 'exitCount', operator: 'lte', value: 1 }] },
      { conditions: [] },
      { conditions: [{ field: 'exitCount', operator: 'gte', value: 0 }] },
      { term: 'specified' },
      { term: 'permanent', expiryDate: '2027-01-01' },
      { reason: '稳定性差' },
      { orgIds: [] },
      { orgIds: ['00000000-0000-4000-8000-000000000000'] },
      { name: ' ' },
      { priority: -1 },
      { description: 'x'.repeat(501) },
      { note: 'x'.repeat(501) },
    ];
    for (const extra of cases) {
      const response = await w.create(w.body(extra));
      expect(response.status, `${JSON.stringify(extra)} → ${await response.clone().text()}`).toBe(400);
    }
    expect((await w.create(w.body(), 3)).status).toBe(409);
    expect(await w.list()).toEqual([]);
  });

  it('同优先级取先登记者（#387 第 1 轮 P2-2）：同一时刻登记 10 条，读取顺序与匹配结果都是首条', async () => {
    const w = await rulesWorld('same-instant');
    // employmentSession 的时钟固定：10 条规则 created_at 完全相同，只能靠登记顺序区分
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const rule = await w.created(
        w.body({
          name: `规则${index}`,
          conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }],
          term: index === 0 ? 'permanent' : 'exit_month',
        }),
      );
      ids.push(rule.id);
    }
    expect((await w.list()).map((r) => r.id)).toEqual(ids);
    const service = (await import(SERVICE).catch(() => null)) as typeof RuleService | null;
    expect(service, '缺少自动加黑规则服务').not.toBeNull();
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const rules = await service!.loadBlacklistRules(tx, w.session.tenant.id);
      expect(matchBlacklistRule(rules, { exitCount: 1, orgChain: [w.org.id] })).toMatchObject({
        id: ids[0],
        name: '规则0',
        term: 'permanent',
      });
    });
    // 改优先级不改登记顺序：首条调到同级的末尾后再调回，仍排在最前
    const first = (await w.list())[0]!;
    expect((await w.update(first.id, 1, w.body({ name: '规则0', priority: 2, term: 'permanent' }))).status).toBe(200);
    expect((await w.update(first.id, 2, w.body({ name: '规则0', priority: 1, term: 'permanent' }))).status).toBe(200);
    expect((await w.list()).map((r) => r.id)).toEqual(ids);
  });

  it('规则服务供 BE-8b 调用：读出规则交给纯函数匹配，多条命中取优先级数字最小者；开关读取有效值', async () => {
    const w = await rulesWorld('service');
    const child = await w.session.org('规则子部门', {
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: w.org.id } },
    });
    const permanent = await w.created(w.body({ priority: 1 }));
    const monthly = await w.created(
      w.body({ name: '每次离职', priority: 2, conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }] }),
    );
    const service = (await import(SERVICE).catch(() => null)) as typeof RuleService | null;
    expect(service, '缺少自动加黑规则服务').not.toBeNull();
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const rules = await service!.loadBlacklistRules(tx, w.session.tenant.id);
      expect(matchBlacklistRule(rules, { exitCount: 1, orgChain: [child.id, w.org.id] })?.id).toBe(monthly.id);
      expect(matchBlacklistRule(rules, { exitCount: 3, orgChain: [child.id, w.org.id] })?.id).toBe(permanent.id);
      expect(matchBlacklistRule(rules, { exitCount: 3, orgChain: [] })).toBeNull();
      expect(await service!.readAutoBlacklistEnabled(tx, w.session.tenant.id)).toBe(false);
    });
  });
});
