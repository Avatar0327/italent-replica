/**
 * AC-TR-08-matrix-round2 · PR #182 第 1 轮审查的 P2 回归（每项先失败）：
 * P2-02 隐藏的排序字段（sortNo / code）不能影响列表顺序与分页；
 * P2-03 命令重放按当前字段目录范围复核引用字段（创建、携带引用的修改），撤范围后重放 404；
 * P2-04 数值轴下界超过存储精度（4 位小数）400，持久化后仍严格递增；
 * P2-05 预置补装核验依赖字段（停用、属性被改、位置字段被占用）：不装不可用的预置九宫格，补装结果里给出受控的原因。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { talentReviewMatrices, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixOperator, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

/** 受控授权：功能权限与范围全开，只隐藏指定字段（DEC-043 范围按用户 × 应用，这里直接给定）。 */
function hiding(...hidden: string[]) {
  const authorize: Authorizer = () => true;
  const visible = new Set(
    [...TALENT_REVIEW_OBJECTS.matrix.fields, ...TALENT_REVIEW_OBJECTS.field.fields]
      .map((field) => field.code)
      .filter((code) => !hidden.includes(code)),
  );
  registerScopeProvider(authorize, {
    scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' }),
    authorize: async () => true,
    fields: async () => visible,
  });
  return tenantApi(testDb().db, { authorize, clock });
}

describe('P2-02 隐藏的排序字段不影响列表顺序与分页', () => {
  it('看不到 sortNo：按可见的 code 排序，管理员改隐藏的 sortNo 不改变第一页', async () => {
    const w = await matrixWorld(testDb().db, 'trm-r2-sort-primary');
    const first = await w.create({ code: 'mx_a_first', sortNo: 9 });
    const second = await w.create({ code: 'mx_b_second', sortNo: 1 });
    const api = hiding('sortNo');
    const page = async (n: number) =>
      (
        (await (await api.request('GET', `${TR_BASE}${MATRICES}?pageSize=1&page=${n}`, w.as)).json()) as {
          items: { id: string }[];
        }
      ).items.map((item) => item.id);
    expect([await page(1), await page(2)]).toEqual([[first.id], [second.id]]);
    const edit = await w.request('PATCH', `${MATRICES}/${second.id}`, { ifMatch: 1, body: { sortNo: 0 } });
    expect(edit.status).toBe(200);
    expect([await page(1), await page(2)]).toEqual([[first.id], [second.id]]);
  });

  it('看不到 code：同 sortNo 时不按 code 排序（用稳定标识），管理员的 code 不可改所以以顺序与 code 无关为准', async () => {
    const w = await matrixWorld(testDb().db, 'trm-r2-sort-secondary');
    const created: MatrixView[] = [];
    for (let i = 0; i < 6; i += 1) created.push(await w.create({ code: `mx_${'zyxwvu'[i]}_${i}`, sortNo: 5 }));
    const api = hiding('code');
    const ids = (
      (await (await api.request('GET', `${TR_BASE}${MATRICES}`, w.as)).json()) as {
        items: { id: string; code?: string }[];
      }
    ).items.map((item) => item.id);
    expect(ids).toEqual(created.map((item) => item.id).sort());
  });

  it('sortNo 与 code 都看不到：按稳定标识排序', async () => {
    const w = await matrixWorld(testDb().db, 'trm-r2-sort-both');
    const created: MatrixView[] = [];
    for (let i = 0; i < 6; i += 1) created.push(await w.create({ code: `mx_${'abcdef'[i]}_${i}`, sortNo: 6 - i }));
    const api = hiding('sortNo', 'code');
    const ids = (
      (await (await api.request('GET', `${TR_BASE}${MATRICES}`, w.as)).json()) as {
        items: { id: string }[];
      }
    ).items.map((item) => item.id);
    expect(ids).toEqual(created.map((item) => item.id).sort());
  });
});

describe('P2-03 命令重放复核引用字段的当前范围', () => {
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
  const refs = async () => ({
    x: await adminField('option', 'result'),
    y: await adminField('option', 'result'),
    before: await adminField('number', 'position'),
    after: await adminField('number', 'position'),
  });

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  it('创建：撤销字段目录范围后，原命令重放 404（新命令 ID 同样 404），业务不变', async () => {
    const operator = await matrixOperator(world, { seeAll: true, fields: 'seeAll' });
    const options = { ifMatch: 0, idempotencyKey: `trm-r2-create-${randomUUID()}`, body: matrixBody(await refs()) };
    expect((await operator.request('POST', MATRICES, options)).status).toBe(201);
    await operator.setSeeAll('field', false);
    const replay = await operator.request('POST', MATRICES, options);
    expect([replay.status, await errorCode(replay)]).toEqual([404, 'NOT_FOUND']);
    const fresh = await operator.request('POST', MATRICES, {
      ...options,
      idempotencyKey: `trm-r2-create-${randomUUID()}`,
      body: matrixBody(await refs()),
    });
    expect(fresh.status).toBe(404);
  });

  it('携带引用字段的修改：撤销字段目录范围后重放 404；不带引用的修改重放不受影响', async () => {
    const operator = await matrixOperator(world, { seeAll: true, fields: 'seeAll' });
    const created = await operator.request('POST', MATRICES, { ifMatch: 0, body: matrixBody(await refs()) });
    const mine = (await created.json()) as MatrixView;
    const moved = {
      ifMatch: 1,
      idempotencyKey: `trm-r2-patch-${randomUUID()}`,
      body: { xFieldId: await adminField('option', 'result') },
    };
    const plain = { ifMatch: 2, idempotencyKey: `trm-r2-plain-${randomUUID()}`, body: { sortNo: 3 } };
    expect((await operator.request('PATCH', `${MATRICES}/${mine.id}`, moved)).status).toBe(200);
    expect((await operator.request('PATCH', `${MATRICES}/${mine.id}`, plain)).status).toBe(200);
    await operator.setSeeAll('field', false);
    const replay = await operator.request('PATCH', `${MATRICES}/${mine.id}`, moved);
    expect([replay.status, await errorCode(replay)]).toEqual([404, 'NOT_FOUND']);
    expect((await operator.request('PATCH', `${MATRICES}/${mine.id}`, plain)).status).toBe(200);
  });
});

describe('P2-04 数值轴下界的存储精度', () => {
  const numericAxis = (score: string, bounds: (number | null)[], base: Record<string, unknown>) => ({
    xFieldId: score,
    axisLevels: [
      ...bounds.map((lowerBound, i) => ({
        axis: 'x',
        levelNo: i + 1,
        name: `段${i + 1}`,
        lowerBound,
        optionValues: [],
      })),
      ...(base.axisLevels as Record<string, unknown>[]).filter((level) => level.axis === 'y'),
    ],
    cells: base.cells,
  });

  it('超过 4 位小数的下界被拒绝（400，数据不变）；4 位以内保存后读回仍严格递增，可启用', async () => {
    const w = await matrixWorld(testDb().db, 'trm-r2-precision');
    const score = (await w.numberField()).id;
    const refs = await w.refs();
    const base = matrixBody(refs);
    const tooFine = await w.post(matrixBody(refs, numericAxis(score, [null, 0.00001, 0.00002], base)));
    expect([tooFine.status, await errorCode(tooFine)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await w.list()).items).toEqual([]);
    const ok = await w.post(matrixBody(refs, { ...numericAxis(score, [null, 0.0001, 0.0002], base), enabled: false }));
    expect(ok.status, await ok.clone().text()).toBe(201);
    const created = (await ok.json()) as MatrixView;
    const stored = (await w.read(created.id)).body.axisLevels.filter((l) => l.axis === 'x').map((l) => l.lowerBound);
    expect(stored).toEqual([null, 0.0001, 0.0002]);
    const enable = await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 1, body: { enabled: true } });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const fine = await w.request('PATCH', `${MATRICES}/${created.id}`, {
      ifMatch: 2,
      body: numericAxis(score, [null, 0.00005, 1], base),
    });
    expect([fine.status, await errorCode(fine)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('P2-05 预置补装核验依赖字段', () => {
  async function legacy(label: string) {
    const w = await matrixWorld(testDb().db, label);
    const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: `${label}-seed` };
    const install = () =>
      withTenant(testDb().db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
    await install();
    // 存量租户：登记表出现前开通，还没有预置九宫格
    await withTenant(testDb().db, w.as.tenant, (tx) => tx.delete(talentReviewMatrices));
    const fields = (await (await w.request('GET', '/fields?pageSize=200')).json()) as {
      items: { id: string; code: string; revision: number }[];
    };
    const field = (code: string) => fields.items.find((item) => item.code === code)!;
    const matrixReport = async () => (await install()).find((item) => item.key === 'preset-matrices')!;
    return { w, field, matrixReport };
  }

  it('X / Y 轴字段已停用：不装依赖它的预置九宫格，补装结果给出原因；另一个照常安装；恢复后再补装', async () => {
    const { w, field, matrixReport } = await legacy('trm-r2-seed-disabled');
    const axis = field('achievement_before');
    const off = await w.request('PATCH', `/fields/${axis.id}`, { ifMatch: axis.revision, body: { enabled: false } });
    expect(off.status).toBe(200);
    const report = await matrixReport();
    expect(report.installed).toEqual(['appraisal_potential']);
    expect(report).toMatchObject({ skipped: [{ code: 'achievement_capability', reason: 'MATRIX_FIELD_DISABLED' }] });
    expect((await w.list()).items.map((item) => item.code)).toEqual(['appraisal_potential']);
    const on = await w.request('PATCH', `/fields/${axis.id}`, { ifMatch: axis.revision + 1, body: { enabled: true } });
    expect(on.status).toBe(200);
    const again = await matrixReport();
    expect(again.installed).toEqual(['achievement_capability']);
    expect(again).not.toHaveProperty('skipped');
  });

  it('位置字段被租户改了分组 / 停用 / 已被其他九宫格占用：同样不装并给出受控原因', async () => {
    const { w, field, matrixReport } = await legacy('trm-r2-seed-position');
    const group = field('achievement_capability_cell_before');
    const regroup = await w.request('PATCH', `/fields/${group.id}`, {
      ifMatch: group.revision,
      body: { group: 'result' },
    });
    expect(regroup.status).toBe(200);
    const off = field('appraisal_potential_cell_after');
    expect(
      (await w.request('PATCH', `/fields/${off.id}`, { ifMatch: off.revision, body: { enabled: false } })).status,
    ).toBe(200);
    const report = await matrixReport();
    expect(report.installed).toEqual([]);
    expect(report.skipped).toEqual([
      { code: 'achievement_capability', reason: 'MATRIX_POSITION_FIELD_KIND' },
      { code: 'appraisal_potential', reason: 'MATRIX_FIELD_DISABLED' },
    ]);
    expect((await w.list()).items).toEqual([]);
  });

  it('预置位置字段已被租户自建的九宫格占用：补装不撞唯一约束，给出 MATRIX_POSITION_FIELD_IN_USE', async () => {
    const { w, field, matrixReport } = await legacy('trm-r2-seed-occupied');
    const refs = await w.refs();
    const claimed = await w.post(matrixBody({ ...refs, before: field('appraisal_potential_cell_before').id }));
    expect(claimed.status, await claimed.clone().text()).toBe(201);
    const report = await matrixReport();
    expect(report.installed).toEqual(['achievement_capability']);
    expect(report.skipped).toEqual([{ code: 'appraisal_potential', reason: 'MATRIX_POSITION_FIELD_IN_USE' }]);
  });
});
