/**
 * F-082 #224 第 1 轮 P2-1：计算规则与字段写入口的事务内重新授权（AGENTS §10 权限、DEC-067；照 #211 runGuarded）。
 * 外层检查通过之后、命令事务提交之前，管理员撤掉按钮 / 范围 / 字段目录范围：用“只在命令事务内才撤销”的授权器确定性地复现这个窗口
 * （事务外的检查看不到撤销，事务内重新解析的才看得到）。开关打开 / 关闭 × 计算规则 / 字段 × 新建 / 修改 / 删除 × 首次 / 重放：
 * - 首次执行：403，业务、revision、审计、命令台账都不提交（撤销解除后同一命令 ID 照常成功）；
 * - 直接重放：撤按钮后 403，不返回先前的成功结果；撤范围后 404；
 * - 保存引用字段时撤字段目录范围：保存被拒，响应里不带已不可见来源的名称和绑定 ID。
 * 去掉写入口的 guard 这些用例必须失败（突变验证见 PR 描述）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { CALC_RULES, calcBody, calcItem, calcWorld, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { catalogVersion, fieldRevision } from './AC-TR-F082-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const FIELD_CODE = TALENT_REVIEW_OBJECTS.field.code;
const visibleCodes = new Set(
  [...TALENT_REVIEW_OBJECTS.calcRule.fields, ...TALENT_REVIEW_OBJECTS.field.fields].map((f) => f.code),
);

/** 只在命令事务内生效的撤销：事务外的检查（外层）永远放行，事务内重新解析才看得到。 */
interface Revocations {
  button: boolean;
  update: boolean;
  scope: boolean;
  fieldScope: boolean;
}
const none = (): Revocations => ({ button: false, update: false, scope: false, fieldScope: false });

function revocableApi(revoked: Revocations, formulaIdBinding: boolean) {
  const authorize: Authorizer = (request) => request.action !== 'data.scope.all';
  registerScopeProvider(authorize, {
    scope: async (query, tx) => {
      const denied = tx && (revoked.scope || (revoked.fieldScope && query.objectCode === FIELD_CODE));
      return denied ? EMPTY_SCOPE : { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
    },
    authorize: async (request, tx) => {
      if (tx && revoked.button && request.action === 'object.button') return false;
      if (tx && revoked.update && request.action === 'object.update') return false;
      return Boolean(await authorize(request));
    },
    fields: async () => visibleCodes,
  });
  return tenantApi(testDb().db, { authorize, clock, formulaIdBinding });
}

type Kind = 'calcRule' | 'field';
type Op = 'create' | 'update' | 'delete';

async function world(label: string, bound: boolean) {
  const w = await calcWorld(testDb().db, label, { formulaIdBinding: bound });
  const revoked = none();
  const api = revocableApi(revoked, bound);
  const send = (method: string, path: string, options: Record<string, unknown> = {}) =>
    api.request(method, `${TR_BASE}${path}`, { ...w.as, ...options });
  return { w, revoked, send };
}

/** 状态码 + 错误码（成功响应没有错误码）：先比状态，失败时读得出是哪里没拦住。 */
const outcome = async (response: Response) => [
  response.status,
  ((await response.clone().json()) as { error?: { code: string } }).error?.code,
];
const auditCount = async (w: Awaited<ReturnType<typeof world>>['w']) => {
  const found = await withTenant(testDb().db, w.as.tenant, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = ${w.as.tenant}`),
  );
  const rows = (Array.isArray(found) ? found : (found as { rows: unknown[] }).rows) as { n: number }[];
  return Number(rows[0]!.n);
};
const ledgerHas = async (w: Awaited<ReturnType<typeof world>>['w'], key: string) => {
  const found = await withTenant(testDb().db, w.as.tenant, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`),
  );
  const rows = (Array.isArray(found) ? found : (found as { rows: unknown[] }).rows) as { n: number }[];
  return Number(rows[0]!.n) > 0;
};

/** 一个场景需要的请求：目标对象已存在（修改 / 删除）或待新建。 */
async function prepare(kind: Kind, op: Op, ctx: Awaited<ReturnType<typeof world>>) {
  const { w } = ctx;
  if (kind === 'field') {
    const body = configBody('field', { kind: 'number', group: 'result' });
    if (op === 'create') return { method: 'POST', path: '/fields', ifMatch: 0, body };
    const field = await w.numberField();
    const ifMatch = await fieldRevision(w, field.id);
    return op === 'update'
      ? { method: 'PATCH', path: `/fields/${field.id}`, ifMatch, body: { sortNo: 9 } }
      : { method: 'DELETE', path: `/fields/${field.id}`, ifMatch, body: undefined };
  }
  const target = await w.numberField();
  if (op === 'create') {
    return { method: 'POST', path: CALC_RULES, ifMatch: 0, body: calcBody([calcItem(target, '1')]) };
  }
  const rule = await w.create(calcBody([calcItem(target, '1')]));
  return op === 'update'
    ? { method: 'PATCH', path: `${CALC_RULES}/${rule.id}`, ifMatch: rule.revision, body: { description: '改' } }
    : { method: 'DELETE', path: `${CALC_RULES}/${rule.id}`, ifMatch: rule.revision, body: undefined };
}

const SCENARIOS: [boolean, Kind, Op][] = [false, true].flatMap((bound) =>
  (['calcRule', 'field'] as const).flatMap((kind) =>
    (['create', 'update', 'delete'] as const).map((op) => [bound, kind, op] as [boolean, Kind, Op]),
  ),
);

describe('P2-1 首次执行：事务内撤按钮 → 403，业务 / 审计 / 台账都不提交', () => {
  it.each(SCENARIOS)('开关=%s %s %s', async (bound, kind, op) => {
    const ctx = await world(`f082-tx1-${bound}-${kind}-${op}`, bound);
    const request = await prepare(kind, op, ctx);
    const key = randomUUID();
    const before = await auditCount(ctx.w);
    ctx.revoked.button = true;
    const denied = await ctx.send(request.method, request.path, {
      ifMatch: request.ifMatch,
      body: request.body,
      idempotencyKey: key,
    });
    expect(await outcome(denied)).toEqual([403, 'FORBIDDEN']);
    expect(await auditCount(ctx.w)).toBe(before);
    expect(await ledgerHas(ctx.w, key)).toBe(false);
    // 撤销解除后，同一个命令 ID 照常成功：说明被拒的那次什么都没提交
    ctx.revoked.button = false;
    const ok = await ctx.send(request.method, request.path, {
      ifMatch: request.ifMatch,
      body: request.body,
      idempotencyKey: key,
    });
    expect([200, 201]).toContain(ok.status);
  });
});

describe('P2-1 幂等重放：撤按钮 → 403；撤范围 → 404（不返回先前的成功结果）', () => {
  it.each(SCENARIOS)('开关=%s %s %s', async (bound, kind, op) => {
    const ctx = await world(`f082-tx2-${bound}-${kind}-${op}`, bound);
    const request = await prepare(kind, op, ctx);
    const key = randomUUID();
    const send = () =>
      ctx.send(request.method, request.path, { ifMatch: request.ifMatch, body: request.body, idempotencyKey: key });
    const first = await send();
    expect([200, 201]).toContain(first.status);
    ctx.revoked.button = true;
    const button = await send();
    expect(await outcome(button)).toEqual([403, 'FORBIDDEN']);
    ctx.revoked.button = false;
    ctx.revoked.scope = true;
    const scope = await send();
    expect(scope.status).toBe(404);
    ctx.revoked.scope = false;
    expect((await send()).status).toBe(first.status);
  });
});

describe('P2-1 提交字段 / 成对字段 / 字段目录范围', () => {
  it('字段新建带 pairFieldId：事务内撤掉字段更新权 → 403，两端都不写', async () => {
    const ctx = await world('f082-tx3-pair', false);
    const partner = await ctx.w.field('number', { name: '成对伙伴' });
    const before = await auditCount(ctx.w);
    ctx.revoked.update = true;
    const response = await ctx.send('POST', '/fields', {
      ifMatch: 0,
      body: configBody('field', { kind: 'number', group: 'result', pairFieldId: partner.id }),
    });
    expect(await outcome(response)).toEqual([403, 'FORBIDDEN']);
    expect(await auditCount(ctx.w)).toBe(before);
  });

  it('开关打开：保存引用字段时事务内撤字段目录范围 → 保存被拒，响应与错误里没有来源名称和绑定 ID', async () => {
    const ctx = await world('f082-tx4-catalog', true);
    const [target, source] = [await ctx.w.numberField(), await ctx.w.field('number', { name: '被撤的来源' })];
    const version = await catalogVersion(testDb().db, ctx.w);
    ctx.revoked.fieldScope = true;
    const response = await ctx.send('POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([calcItem(target, '盘点对象.被撤的来源 + 1', { formulaBindings: [source.id] })], {
        fieldCatalogVersion: version,
      }),
    });
    const text = await response.text();
    expect(response.status).not.toBe(201);
    for (const hidden of ['被撤的来源', source.id]) expect(text, hidden).not.toContain(hidden);
    ctx.revoked.fieldScope = false;
    const rules = (await ctx.w.list()).items as CalcRuleView[];
    expect(rules).toHaveLength(0);
  });
});
