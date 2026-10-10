/**
 * AC-TR-08-matrix-round3 · PR #182 第 2 轮审查的 P2 / P3 回归（每项先失败）：
 * - 首次执行的 PATCH 在业务事务内复核显式提交的全部字段引用（原 X / 原 Y / 原非空 Z / 原位置字段）：失去字段目录范围的
 *   操作人原样带上已有引用并改名称 → 404，且业务、revision、命令台账、审计都没有新写入；
 * - 分类 / 角色 / 字段 / 准备度列表不按查看人看不到的排序字段排序（主排序 sortNo、次排序 name / code），分页一致；
 * - 数值轴下界按存储精度严格判断：1e-11、2e-11 这类入库会被舍成 0 的值 400。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { and, auditEvents, commandLedger, eq, talentReviewMatrices, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { configBody, configWorld, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixOperator, type MatrixView } from './AC-TR-matrix-support.js';
import { readinessBody, readinessWorld } from './AC-TR-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe('AC-TR-08 首次 PATCH 在业务事务内复核显式提交的字段引用（第 2 轮 P2）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const adminField = async (kind: 'option' | 'number', group: string) => {
    const options = [
      { value: '1', label: '低' },
      { value: '2', label: '中' },
      { value: '3', label: '高' },
    ];
    const response = await setup.request('POST', `${TR_BASE}/fields`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: configBody('field', kind === 'option' ? { kind, group, options } : { kind, group }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  /** 操作人有九宫格看全部、字段目录看全部时建九宫格（引用管理员建的字段），随后撤掉字段目录的看全部。 */
  async function lostFieldScope() {
    const operator = await matrixOperator(world, { seeAll: true, fields: 'seeAll' });
    const refs = {
      x: await adminField('option', 'result'),
      y: await adminField('option', 'result'),
      before: await adminField('number', 'position'),
      after: await adminField('number', 'position'),
    };
    const z = await adminField('option', 'result');
    const created = await operator.request('POST', MATRICES, { ifMatch: 0, body: matrixBody(refs, { zFieldId: z }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const matrix = (await created.json()) as MatrixView;
    await operator.setSeeAll('field', false);
    return { operator, matrix };
  }

  const stored = (tenantId: string, id: string) =>
    withTenant(world.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({ name: talentReviewMatrices.name, revision: talentReviewMatrices.revision })
        .from(talentReviewMatrices)
        .where(eq(talentReviewMatrices.id, id));
      const audits = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.objectId, id), eq(auditEvents.action, 'talent-review.matrix.update')));
      return { ...row, updates: audits.length };
    });
  const ledger = (tenantId: string, commandId: string) =>
    withTenant(world.db, tenantId, (tx) =>
      tx
        .select({ status: commandLedger.responseStatus })
        .from(commandLedger)
        .where(eq(commandLedger.commandId, commandId)),
    );

  it.each([
    ['原 X', (m: MatrixView) => ({ xFieldId: m.xFieldId })],
    ['原 Y', (m: MatrixView) => ({ yFieldId: m.yFieldId })],
    ['原非空 Z', (m: MatrixView) => ({ zFieldId: m.zFieldId })],
    ['原位置字段', (m: MatrixView) => ({ positionFields: m.positionFields })],
  ] as const)('%s原样带上并改名称：404，名称 / revision / 台账 / 审计都不变', async (_label, carry) => {
    const { operator, matrix } = await lostFieldScope();
    const commandId = `trm-r3-ref-${randomUUID()}`;
    const response = await operator.request('PATCH', `${MATRICES}/${matrix.id}`, {
      ifMatch: 1,
      idempotencyKey: commandId,
      body: { name: `改名${randomUUID().slice(0, 6)}`, ...carry(matrix) },
    });
    expect([response.status, await errorCode(response)]).toEqual([404, 'NOT_FOUND']);
    expect(await stored(operator.as.tenant, matrix.id)).toEqual({ name: matrix.name, revision: 1, updates: 0 });
    expect(await ledger(operator.as.tenant, commandId)).toEqual([]);
  });

  it('不带字段引用的修改不受字段目录范围影响', async () => {
    const { operator, matrix } = await lostFieldScope();
    const response = await operator.request('PATCH', `${MATRICES}/${matrix.id}`, { ifMatch: 1, body: { sortNo: 7 } });
    expect(response.status, await response.clone().text()).toBe(200);
  });
});

/** 受控授权：功能权限与范围全开，只隐藏指定对象的指定字段。 */
function hiding(object: keyof typeof TALENT_REVIEW_OBJECTS, ...hidden: string[]) {
  const authorize: Authorizer = () => true;
  const target = TALENT_REVIEW_OBJECTS[object].code;
  const all = (code: string) =>
    new Set(
      Object.values(TALENT_REVIEW_OBJECTS)
        .find((item) => item.code === code)!
        .fields.map((field) => field.code),
    );
  registerScopeProvider(authorize, {
    scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' }),
    authorize: async () => true,
    fields: async (_tenant, _user, code) =>
      code === target ? new Set([...all(code)].filter((field) => !hidden.includes(field))) : all(code),
  });
  return tenantApi(testDb().db, { authorize, clock });
}

type Lister = { readonly path: string; readonly object: 'category' | 'role' | 'field' | 'readiness' };
const LISTS: readonly (Lister & { readonly secondary: string })[] = [
  { path: '/categories', object: 'category', secondary: 'name' },
  { path: '/roles', object: 'role', secondary: 'code' },
  { path: '/fields', object: 'field', secondary: 'code' },
  { path: '/readiness-levels', object: 'readiness', secondary: 'code' },
];

/** 一个租户里按对象建一条记录（全部允许）；返回改 sortNo 的方法。 */
async function listWorld(object: Lister['object'], label: string) {
  if (object === 'readiness') {
    const w = await readinessWorld(testDb().db, label);
    return {
      as: w.as,
      create: async (extra: Record<string, unknown>) => (await w.create(readinessBody(extra))) as { id: string },
      edit: (id: string, revision: number, body: Record<string, unknown>) =>
        w.request('PATCH', `/readiness-levels/${id}`, { ifMatch: revision, body }),
    };
  }
  const w = await configWorld(testDb().db, label);
  const path = { category: '/categories', role: '/roles', field: '/fields' }[object];
  return {
    as: w.as,
    create: (extra: Record<string, unknown>) => w.create(object, configBody(object, extra)),
    edit: (id: string, revision: number, body: Record<string, unknown>) =>
      w.request('PATCH', `${path}/${id}`, { ifMatch: revision, body }),
  };
}

const idsOf = async (api: ReturnType<typeof tenantApi>, path: string, as: object, query: string) =>
  (
    (await (await api.request('GET', `${TR_BASE}${path}?${query}`, as)).json()) as {
      items: { id: string }[];
    }
  ).items.map((item) => item.id);

/** 整表顺序，以及逐页（pageSize=1）拼起来的顺序：两者必须一致。 */
async function order(api: ReturnType<typeof tenantApi>, path: string, as: object) {
  const whole = await idsOf(api, path, as, 'pageSize=200');
  const pages: string[] = [];
  for (let page = 1; page <= whole.length; page += 1)
    pages.push(...(await idsOf(api, path, as, `pageSize=1&page=${page}`)));
  expect(pages).toEqual(whole);
  return whole;
}

describe('AC-TR-08 / AC-TR-config 配置列表不按看不到的排序字段排序（第 2 轮 P2，DEC-317① 信息泄露例外）', () => {
  it.each(LISTS)('$path 看不到 sortNo：管理员只改隐藏的 sortNo，顺序与分页都不变', async ({ path, object }) => {
    const w = await listWorld(object, `trm-r3-sort-${object}`);
    const a = await w.create({ sortNo: 9 });
    const b = await w.create({ sortNo: 1 });
    const api = hiding(object, 'sortNo');
    const before = await order(api, path, w.as);
    expect(before).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await w.edit(b.id, 1, { sortNo: 99 })).status).toBe(200);
    expect((await w.edit(a.id, 1, { sortNo: 0 })).status).toBe(200);
    expect(await order(api, path, w.as)).toEqual(before);
  });

  it.each(LISTS)('$path 看不到次排序 $secondary：同 sortNo 的记录按稳定标识排，与 $secondary 无关', async (list) => {
    const w = await listWorld(list.object, `trm-r3-sort2-${list.object}`);
    const mine: string[] = [];
    for (const letter of 'zyxwvu') {
      const extra = list.secondary === 'name' ? { name: `${letter}名称${randomUUID().slice(0, 4)}` } : {};
      const code =
        list.object === 'readiness'
          ? { code: `${letter.toUpperCase()}${randomUUID().slice(0, 4)}` }
          : list.secondary === 'code'
            ? { code: `${letter}_${randomUUID().slice(0, 4)}` }
            : {};
      mine.push((await w.create({ sortNo: 5, ...extra, ...code })).id);
    }
    const api = hiding(list.object, list.secondary);
    const whole = await order(api, list.path, w.as);
    expect(whole.filter((id) => mine.includes(id))).toEqual([...mine].sort());
  });
});
