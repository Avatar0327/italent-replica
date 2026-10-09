/**
 * AC-TR-08-matrix-preset · R3-T04 PR-B4 预置两个九宫格（设计 §2.7；TR-R31；DEC-361）：业绩-能力、绩效-潜力，
 * 经种子补装登记表安装（开通与平台回补共用 installMissingSeeds）：只补缺失编码、不覆盖租户定制、写审计；
 * 预置的位置字段占用 4 个预置位置字段，其他九宫格不能再占；预置九宫格不能删除（可停用）。
 */
import { talentReviewFields, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';

const testDb = useTestDb();
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

async function installed(label: string) {
  const w = await matrixWorld(testDb().db, label);
  const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: `${label}-seed` };
  const install = () =>
    withTenant(testDb().db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
  const report = await install();
  const fields = await withTenant(testDb().db, w.as.tenant, (tx) =>
    tx.select({ id: talentReviewFields.id, code: talentReviewFields.code }).from(talentReviewFields),
  );
  const idOf = (code: string) => fields.find((row) => row.code === code)!.id;
  return { w, install, report, idOf };
}

describe('预置九宫格（TR-R31；DEC-361）', () => {
  it('补装登记两个预置九宫格：业绩-能力、绩效-潜力，3 × 3 分段、9 个格子、校准前 / 后位置字段', async () => {
    const { w, report, idOf } = await installed('trm-preset');
    expect(report.find((item) => item.key === 'preset-matrices')).toMatchObject({
      module: 'talent-review',
      installed: ['achievement_capability', 'appraisal_potential'],
      existing: 0,
    });
    const items = (await w.list()).items;
    expect(items.map((item) => [item.code, item.name, item.preset])).toEqual([
      ['achievement_capability', '业绩-能力', true],
      ['appraisal_potential', '绩效-潜力', true],
    ]);
    const first = items[0]!;
    expect(first).toMatchObject({
      xFieldId: idOf('achievement_before'),
      yFieldId: idOf('capability_before'),
      zFieldId: null,
      placementSource: 'after_else_before',
      enabled: true,
      ratioGroups: [],
    });
    expect(first.positionFields).toEqual([
      { role: 'before', fieldId: idOf('achievement_capability_cell_before') },
      { role: 'after', fieldId: idOf('achievement_capability_cell_after') },
    ]);
    expect(first.axisLevels.filter((level) => level.axis === 'x').map((level) => level.optionValues)).toEqual([
      ['1'],
      ['2'],
      ['3'],
    ]);
    expect(first.cells.map((cell) => cell.cellNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(items[1]!.positionFields.map((row) => row.fieldId)).toEqual([
      idOf('appraisal_potential_cell_before'),
      idOf('appraisal_potential_cell_after'),
    ]);
  });

  it('重复补装无副作用；租户改名 / 停用后回补不覆盖；新建的九宫格不能占用预置位置字段', async () => {
    const { w, install, idOf } = await installed('trm-preset-again');
    const [first] = (await w.list()).items;
    const renamed = await w.request('PATCH', `${MATRICES}/${first!.id}`, {
      ifMatch: 1,
      body: { name: '改过的名称', enabled: false },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const before = (await w.list()).items;
    const report = await install();
    expect(report.find((item) => item.key === 'preset-matrices')).toMatchObject({ installed: [], existing: 2 });
    expect((await w.list()).items).toEqual(before);
    const refs = {
      ...(await w.refs()),
      before: idOf('achievement_capability_cell_before'),
    };
    const claim = await w.post(matrixBody(refs));
    expect([claim.status, await reasonOf(claim)]).toEqual([409, 'MATRIX_POSITION_FIELD_IN_USE']);
    expect((await w.list()).items).toEqual(before);
  });

  it('预置九宫格不能删除（409 MATRIX_PRESET），可以停用；补装写数据变更日志（系统写入）', async () => {
    const { w } = await installed('trm-preset-delete');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const [first] = (await w.list()).items as [MatrixView];
    const response = await w.request('DELETE', `${MATRICES}/${first.id}`, { ifMatch: 1 });
    expect([response.status, await reasonOf(response)]).toEqual([409, 'MATRIX_PRESET']);
    expect((await w.read(first.id)).body).toEqual(first);
    const { items } = await audit.dataChanges(w.as, { objectType: 'TalentReview.Matrix', limit: '50' });
    expect(items.filter((entry) => entry.operation === 'create')).toHaveLength(2);
  });
});
