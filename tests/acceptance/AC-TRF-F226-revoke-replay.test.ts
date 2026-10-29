/**
 * F-226 / #403 后补 P3：入口 9、10 沿用 F-181a 同单写入口的撤权模型。
 * 失败状态由真实调动、合同写入口及现有审批 / 定时生效夹具构造，不直接改库。
 * 入口仍放行，命令事务内收空范围 / 换成无关部门，同键重放须拒绝且不披露原回执。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { linkageWorld, type LinkageWorld } from './AC-LNK-support.js';
import { orgScope, revocable } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const AT = '2026-10-11T02:00:00Z';
const BASE = '/api/tenant/employment';
type Person = Awaited<ReturnType<LinkageWorld['hire']>>;

interface RetryTarget {
  readonly businessId: string;
  readonly path: string;
  readonly revision: number;
  readonly expected: Readonly<Record<string, unknown>> & { readonly id: string; readonly status: string };
  readonly read: () => Promise<unknown>;
}

/** AC-LNK-04 / DEC-052：接收人汇报给待转交下属，转交将形成环，主调动生效而子项失败。 */
async function failedLinkage(w: LinkageWorld, person: Person): Promise<RetryTarget> {
  const subordinate = await w.hire('合成下属', { directManagerId: person.employee.id });
  const receiver = await w.hire('合成接收人', { directManagerId: subordinate.employee.id });
  const business = await w.saved(
    await w.transfer(person, {
      linkage: {
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' }],
        },
      },
    }),
  );
  await w.approve(business, '2026-10-02T01:00:00Z');
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({
    activated: [business.id],
    failed: [],
    errors: [],
  });
  const view = await w.linkage(business.id);
  expect(view.dutyTransfer).toMatchObject({ total: 1, failedCount: 1 });
  const item = view.dutyTransfer!.items[0]!;
  expect(item).toMatchObject({ status: 'failed', attemptCount: 1, subordinateId: subordinate.employee.id });
  expect(item.failure?.code).toBeTruthy();
  return {
    businessId: business.id,
    path: `/transfers/linkage-items/${item.id}/retry`,
    revision: item.revision,
    expected: { id: item.id, status: 'failed', attemptCount: 2 },
    read: async () => (await w.linkage(business.id)).dutyTransfer!.items.find((entry) => entry.id === item.id),
  };
}

/** AC-TRF-31 / DEC-183：审批通过后出现同类型在途合同，到期时整单失败。 */
async function failedActivation(w: LinkageWorld, person: Person): Promise<RetryTarget> {
  const current = await w.contract(person.employee.id);
  const business = await w.saved(await w.transfer(person, { linkage: { contract: { targetId: current.id } } }));
  await w.approve(business, '2026-10-02T01:00:00Z');
  await w.contract(person.employee.id, { effectiveDate: '2026-12-01', endDate: '2027-11-30' }, 'application');
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({
    activated: [],
    failed: [business.id],
    errors: [],
  });
  const failed = await w.business(business.id);
  expect(failed).toMatchObject({
    status: 'approved',
    activation: { status: 'failed', failureCount: 1, failureReason: 'RULE_REJECTED' },
  });
  const attempts = (await w.auditEvents(business.id)).filter(
    (event) => event.action === 'employment.activation.failed',
  );
  expect(attempts.at(-1)!.after).toMatchObject({ detail: { rule: 'TRANSFER_CONTRACT_IN_FLIGHT' } });
  return {
    businessId: business.id,
    path: `/businesses/${business.id}/activation/retry`,
    revision: failed.revision,
    expected: {
      id: business.id,
      status: 'approved',
      activation: { status: 'failed', failureCount: 2, failureReason: 'RULE_REJECTED' },
    },
    read: () => w.business(business.id),
  };
}

const PATHS = [
  { name: '入口 9 POST /transfers/linkage-items/:id/retry', prepare: failedLinkage },
  { name: '入口 10 POST /businesses/:id/activation/retry', prepare: failedActivation },
] as const;

/** 全行快照同时捕获新增与原地改写，特别是重试次数、台账内容和槽位指针。 */
async function state(w: LinkageWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result: Record<string, unknown> = {};
    for (const table of [
      'employment_employees',
      'employment_business_objects',
      'employment_payload_versions',
      'employment_state_events',
      'employment_records',
      'employment_activation_attempts',
      'employment_outbox',
      'transfer_linkage_runs',
      'transfer_linkage_items',
      'transfer_draft_slots',
      'contract_records',
      'contract_changes',
      'audit_events',
      'command_ledger',
    ]) {
      const rows = await tx.execute(sql`SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t
        WHERE tenant_id=${w.session.tenant.id} ORDER BY to_jsonb(t)::text`);
      result[table] = Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows;
    }
    return result;
  });
}

async function firstDone(prepare: (w: LinkageWorld, person: Person) => Promise<RetryTarget>) {
  const w = await linkageWorld(database().db, 'f226-retry');
  const person = await w.hire('合成调动员工');
  const target = await prepare(w, person);
  const third = await w.session.org('合成无关部门', { establishedOn: '2026-01-01' });
  const { authorize, rights } = revocable();
  // 这两个入口没有 Switch 31 目标例外；入口与首次命令都显式包含源、目标部门。
  rights.entryScope = orgScope(w.session.tenant.id, '2026-10-11', w.from.id, w.to.id);
  rights.scope = rights.entryScope;
  const api = tenantApi(w.db, { authorize, clock: () => new Date(AT) });
  const key = randomUUID();
  const replay = () =>
    api.request('POST', `${BASE}${target.path}`, {
      ...w.as,
      ifMatch: target.revision,
      idempotencyKey: key,
      body: {},
    });
  const beforeFirst = await state(w);
  const first = await replay();
  expect(first.status, await first.clone().text()).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({ id: target.expected.id, status: target.expected.status });
  // 未修正失败原因，首次重试确实执行并把失败次数加一；后续同键请求不得再执行。
  // 次数可能被受限响应裁掉，用现有全权读夹具核对持久化结果，不扩大测试授权器的字段集合。
  expect(await target.read()).toMatchObject(target.expected);
  const afterFirst = await state(w);
  expect(afterFirst).not.toEqual(beforeFirst);
  return { w, person, target, third, rights, replay, body, afterFirst };
}

type World = Awaited<ReturnType<typeof firstDone>>;
const GONE: ReadonlyArray<readonly [string, (x: World) => void]> = [
  [
    '数据范围收为空',
    (x) => {
      x.rights.scope = undefined;
      x.rights.emptyScope = true;
    },
  ],
  [
    '范围换成无关的第三部门',
    (x) => {
      x.rights.scope = orgScope(x.w.session.tenant.id, '2026-10-11', x.third.id);
    },
  ],
];

describe.each(PATHS)('AC-TRF-F226 $name 撤权重放', ({ prepare }) => {
  it('对照：权限不变同键重放返回原响应，业务 / 审计 / 台账 / 槽位不变', async () => {
    const x = await firstDone(prepare);
    const replay = await x.replay();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(x.body);
    expect(await state(x.w)).toEqual(x.afterFirst);
  });

  it.each(GONE)('首次成功后%s：同键重放被拒，不披露原回执，所有快照不变', async (_name, apply) => {
    const x = await firstDone(prepare);
    apply(x);
    const replay = await x.replay();
    const text = await replay.text();
    expect([403, 404], text).toContain(replay.status);
    for (const value of [x.target.businessId, x.target.expected.id, x.person.employee.id, x.w.to.id]) {
      expect(text, '被拒响应不得披露单据 / 联动子项 / 员工 / 目标部门').not.toContain(value);
    }
    expect(await state(x.w)).toEqual(x.afterFirst);
  });
});
