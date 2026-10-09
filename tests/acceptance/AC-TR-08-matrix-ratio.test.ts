/**
 * AC-TR-08-matrix-ratio · R3-T04 PR-B4 比例规则组（设计 §2.2 ratio_rule_groups / _rules / _rule_cells；TR-R33）：
 * 一个九宫格可有多组规则，最多一组默认；每条规则 = 运算符 + 百分比 + 格子集合（格子须属于本九宫格）；组名在九宫格内唯一；
 * 规则组写入的 If-Match 是九宫格的 revision（每次写入 +1），响应是更新后的九宫格聚合；被项目引用的规则组不可删（引用守卫）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerRatioGroupReferenceGuard } from '../../apps/api/src/modules/talent-review/matrix-service.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixWorld, type MatrixView, ratioGroupBody } from './AC-TR-matrix-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerRatioGroupReferenceGuard(async (_tx, _tenantId, groupId) => (referenced.has(groupId) ? 'TEST_PROJECT' : null));
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

describe('比例规则组（TR-R33）', () => {
  it('新建规则组：返回九宫格聚合且 revision +1；规则、格子集合、控制范围 / 方式 / 起始人数都保存', async () => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-create');
    const matrix = await w.create();
    const body = ratioGroupBody({
      controlMode: 'block',
      minPopulation: 10,
      rules: [
        { operator: 'lte', pctLow: 20, cellNos: [9] },
        { operator: 'between', pctLow: 5, pctHigh: 15.5, cellNos: [7, 8, 4] },
      ],
    });
    const response = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, { ifMatch: 1, body });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('etag')).toBe('"2"');
    const updated = (await response.json()) as MatrixView;
    expect(updated).toMatchObject({ id: matrix.id, revision: 2 });
    expect(updated.ratioGroups).toHaveLength(1);
    expect(updated.ratioGroups[0]).toMatchObject({
      name: body.name,
      isDefault: false,
      controlScope: 'project_meeting',
      controlMode: 'block',
      minPopulation: 10,
      rules: [
        { operator: 'lte', pctLow: 20, pctHigh: null, cellNos: [9] },
        { operator: 'between', pctLow: 5, pctHigh: 15.5, cellNos: [4, 7, 8] },
      ],
    });
    expect((await w.read(matrix.id)).body).toEqual(updated);
  });

  it('默认组至多一个：把另一组设为默认会取消原默认；组名在九宫格内唯一（别的九宫格可同名）', async () => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-default');
    const matrix = await w.create();
    const other = await w.create();
    const add = async (id: string, revision: number, extra: Record<string, unknown>) => {
      const response = await w.request('POST', `${MATRICES}/${id}/ratio-groups`, {
        ifMatch: revision,
        body: ratioGroupBody(extra),
      });
      return { response, view: (await response.clone().json()) as MatrixView };
    };
    const a = await add(matrix.id, 1, { name: '组 A', isDefault: true });
    const b = await add(matrix.id, 2, { name: '组 B', isDefault: true });
    expect(b.view.ratioGroups.map((g) => [g.name, g.isDefault])).toEqual([
      ['组 A', false],
      ['组 B', true],
    ]);
    const dup = await add(matrix.id, 3, { name: '组 A' });
    expect([dup.response.status, await reasonOf(dup.response)]).toEqual([409, 'RATIO_GROUP_DUPLICATE']);
    expect((await w.read(matrix.id)).body).toEqual(b.view);
    expect((await add(other.id, 1, { name: '组 A' })).response.status).toBe(201);
    expect(a.view.ratioGroups[0]!.isDefault).toBe(true);
  });

  it.each([
    ['格子不属于本九宫格', { rules: [{ operator: 'lte', pctLow: 20, cellNos: [10] }] }, 'RATIO_RULE_CELL_UNKNOWN'],
    ['范围运算缺上限', { rules: [{ operator: 'between', pctLow: 5, cellNos: [1] }] }, 'RATIO_RULE_INVALID'],
    [
      '范围运算上限小于下限',
      { rules: [{ operator: 'between', pctLow: 15, pctHigh: 5, cellNos: [1] }] },
      'RATIO_RULE_INVALID',
    ],
    ['非范围运算带上限', { rules: [{ operator: 'gt', pctLow: 5, pctHigh: 9, cellNos: [1] }] }, 'RATIO_RULE_INVALID'],
    ['格子集合重复', { rules: [{ operator: 'gt', pctLow: 5, cellNos: [1, 1] }] }, 'RATIO_RULE_INVALID'],
  ] as const)('规则非法 · %s：400，数据不变', async (_name, extra, reason) => {
    const w = await matrixWorld(testDb().db, `trm-ratio-${reason}`);
    const matrix = await w.create();
    const response = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
      ifMatch: 1,
      body: ratioGroupBody(extra),
    });
    expect([response.status, await reasonOf(response)]).toEqual([400, reason]);
    expect((await w.read(matrix.id)).body).toEqual(matrix);
  });

  it.each([
    ['没有规则', { rules: [] }],
    ['百分比超过 100', { rules: [{ operator: 'lte', pctLow: 101, cellNos: [1] }] }],
    ['运算符未知', { rules: [{ operator: 'neq', pctLow: 1, cellNos: [1] }] }],
    ['控制方式未知', { controlMode: 'ignore' }],
    ['多余字段', { unknown: 1 }],
  ])('结构非法 · %s：400 VALIDATION_FAILED', async (_name, extra) => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-shape');
    const matrix = await w.create();
    const response = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
      ifMatch: 1,
      body: ratioGroupBody(extra),
    });
    expect([response.status, await errorCode(response)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await w.read(matrix.id)).body).toEqual(matrix);
  });

  it('修改规则组保持组标识、整组替换规则；revision 不符 409；同幂等键重放首次结果', async () => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-patch');
    const matrix = await w.create();
    const created = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
      ifMatch: 1,
      body: ratioGroupBody(),
    });
    const withGroup = (await created.json()) as MatrixView;
    const group = withGroup.ratioGroups[0]!;
    const path = `${MATRICES}/${matrix.id}/ratio-groups/${group.id}`;
    const stale = await w.request('PATCH', path, { ifMatch: 1, body: { controlMode: 'block' } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    const options = {
      ifMatch: 2,
      idempotencyKey: 'trm-ratio-patch-1',
      body: { controlMode: 'block', isDefault: true, rules: [{ operator: 'gte', pctLow: 30, cellNos: [1, 2] }] },
    };
    const first = await w.request('PATCH', path, options);
    expect(first.status, await first.clone().text()).toBe(200);
    const updated = (await first.json()) as MatrixView;
    expect(updated.revision).toBe(3);
    expect(updated.ratioGroups[0]).toMatchObject({
      id: group.id,
      name: group.name,
      controlMode: 'block',
      isDefault: true,
      rules: [{ operator: 'gte', pctLow: 30, cellNos: [1, 2] }],
    });
    const replay = await w.request('PATCH', path, options);
    expect([replay.status, await replay.json()]).toEqual([200, updated]);
    expect((await w.read(matrix.id)).body.revision).toBe(3);
    const missing = await w.request('PATCH', `${MATRICES}/${matrix.id}/ratio-groups/${matrix.id}`, {
      ifMatch: 3,
      body: { controlMode: 'warn' },
    });
    expect(missing.status).toBe(404);
  });

  it('删除规则组：被项目引用 409 RATIO_GROUP_IN_USE（数据不变），未引用可删；删九宫格同时删规则组', async () => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-delete');
    const matrix = await w.create();
    const created = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
      ifMatch: 1,
      body: ratioGroupBody(),
    });
    const withGroup = (await created.json()) as MatrixView;
    const group = withGroup.ratioGroups[0]!;
    const path = `${MATRICES}/${matrix.id}/ratio-groups/${group.id}`;
    referenced.add(group.id);
    const blocked = await w.request('DELETE', path, { ifMatch: 2 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'RATIO_GROUP_IN_USE', referrer: 'TEST_PROJECT' } },
    });
    expect((await w.read(matrix.id)).body).toEqual(withGroup);
    referenced.delete(group.id);
    const removed = await w.request('DELETE', path, { ifMatch: 2 });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ revision: 3, ratioGroups: [] });
    expect((await w.request('DELETE', path, { ifMatch: 3 })).status).toBe(404);
    await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, { ifMatch: 3, body: ratioGroupBody() });
    expect((await w.request('DELETE', `${MATRICES}/${matrix.id}`, { ifMatch: 4 })).status).toBe(200);
  });

  it('规则组按创建顺序排列：删除中间的组后新增的组排在最后', async () => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-order');
    const matrix = await w.create();
    let view = matrix;
    for (const name of ['甲', '乙', '丙']) {
      const response = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
        ifMatch: view.revision,
        body: ratioGroupBody({ name }),
      });
      view = (await response.json()) as MatrixView;
    }
    const middle = view.ratioGroups[0]!;
    const removed = await w.request('DELETE', `${MATRICES}/${matrix.id}/ratio-groups/${middle.id}`, {
      ifMatch: view.revision,
    });
    view = (await removed.json()) as MatrixView;
    const added = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
      ifMatch: view.revision,
      body: ratioGroupBody({ name: '丁' }),
    });
    expect(((await added.json()) as MatrixView).ratioGroups.map((group) => group.name)).toEqual(['乙', '丙', '丁']);
  });

  it('规则组变更记入九宫格的数据变更日志（ratioGroups 字段）', async () => {
    const w = await matrixWorld(testDb().db, 'trm-ratio-audit');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const matrix = await w.create();
    await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, { ifMatch: 1, body: ratioGroupBody() });
    const { items } = await audit.dataChanges(w.as, { objectType: 'TalentReview.Matrix', limit: '50' });
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['ratioGroups']);
  });
});
