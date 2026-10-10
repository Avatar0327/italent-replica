/**
 * AC-TR-08-matrix-f085 · F-085 九宫格对齐原站（DEC-389①；26 末尾补充 Q-M0-156 / 157；DEC-361）：
 * - 轴只能是等级维度（单选）字段，数值字段不行（旧用例改在 AC-TR-08-matrix）；
 * - 比例规则组不要求有默认组（零个或一个都行，至多一个）；
 * - 预置“绩效-潜力”：X = 潜力、Y = 绩效；格子编号从左下 1 沿对角线到右上 9，名称按原站，文字黑色，背景三档蓝，
 *   导出顺序 9-7-8-5-4-6-2-3-1；绿化率默认关，打开后逐格标记是否计入；
 * - 种子常量变更走 DEC-361 回补：已安装的不覆盖。
 */
import { talentReviewFields, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixWorld, ratioGroupBody, type MatrixView } from './AC-TR-matrix-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

type CellView = MatrixView['cells'][number] & { textColor?: string; exportOrder?: number | null };

async function installed(label: string) {
  const w = await matrixWorld(testDb().db, label);
  const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: `${label}-seed` };
  const install = () =>
    withTenant(testDb().db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
  await install();
  const fields = await withTenant(testDb().db, w.as.tenant, (tx) =>
    tx.select({ id: talentReviewFields.id, code: talentReviewFields.code }).from(talentReviewFields),
  );
  const idOf = (code: string) => fields.find((row) => row.code === code)!.id;
  const preset = (await w.list()).items.find((item) => item.code === 'appraisal_potential')!;
  return { w, install, idOf, preset };
}

/** 原站“绩效-潜力”：行 = 绩效（Y，低 / 中 / 高），列 = 潜力（X，低 / 中 / 高）；DEC-389①。 */
const GRID: Record<number, { x: number; y: number; name: string; color: string }> = {
  1: { x: 1, y: 1, name: '提升绩效人才', color: '#C3D8F1' },
  2: { x: 2, y: 1, name: '稳定人才', color: '#C3D8F1' },
  3: { x: 1, y: 2, name: '自我提升人才', color: '#C3D8F1' },
  4: { x: 3, y: 1, name: '关注人才', color: '#D5EBFD' },
  5: { x: 2, y: 2, name: '可靠人才', color: '#D5EBFD' },
  6: { x: 1, y: 3, name: '关注人才', color: '#D5EBFD' },
  7: { x: 3, y: 2, name: '核心人才', color: '#EDF8FF' },
  8: { x: 2, y: 3, name: '核心人才', color: '#EDF8FF' },
  9: { x: 3, y: 3, name: '明星人才', color: '#EDF8FF' },
};
const EXPORT_ORDER = [9, 7, 8, 5, 4, 6, 2, 3, 1];

describe('F-085 轴只能是等级维度字段（Q-M0-156）', () => {
  it.each(['x', 'y'] as const)(
    '%s 轴选数值 / 文本 / 多选字段 400 MATRIX_AXIS_FIELD_KIND；单选字段通过',
    async (axis) => {
      const w = await matrixWorld(testDb().db, `trm-f085-axis-${axis}`);
      const refs = await w.refs();
      const key = `${axis}FieldId`;
      for (const bad of [await w.numberField(), await w.textField()]) {
        const response = await w.post(matrixBody(refs, { [key]: bad.id }));
        expect([response.status, await reasonOf(response)]).toEqual([400, 'MATRIX_AXIS_FIELD_KIND']);
      }
      expect((await w.list()).items).toEqual([]);
      expect((await w.post(matrixBody(refs))).status).toBe(201);
    },
  );

  it('2 × 2 的九宫格可以保存（段数可不为 3，PA-Ability）', async () => {
    const w = await matrixWorld(testDb().db, 'trm-f085-2x2');
    const refs = await w.refs();
    const base = matrixBody(refs);
    const levels = (base.axisLevels as { axis: string; levelNo: number; optionValues: string[] }[]).filter(
      (level) => level.levelNo !== 2,
    );
    // 低 / 高 两段：高段合并 2 和 3 两个选项值
    const fixed = levels.map((level) =>
      level.levelNo === 3 ? { ...level, levelNo: 2, optionValues: ['2', '3'] } : level,
    );
    const cells = [1, 2].flatMap((y) =>
      [1, 2].map((x) => ({
        cellNo: (y - 1) * 2 + x,
        xLevelNo: x,
        yLevelNo: y,
        name: `格${(y - 1) * 2 + x}`,
        color: '#C3D8F1',
      })),
    );
    const response = await w.post({ ...base, axisLevels: fixed, cells });
    expect(response.status, await response.clone().text()).toBe(201);
  });
});

describe('F-085 比例规则组不要求有默认组（Q-M0-156）', () => {
  it('没有默认组可以保存；删除 / 取消默认后回到零个默认；设为默认仍至多一个', async () => {
    const w = await matrixWorld(testDb().db, 'trm-f085-default');
    const matrix = await w.create();
    const add = async (revision: number, extra: Record<string, unknown>) => {
      const response = await w.request('POST', `${MATRICES}/${matrix.id}/ratio-groups`, {
        ifMatch: revision,
        body: ratioGroupBody(extra),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as MatrixView;
    };
    const defaults = (view: MatrixView) => view.ratioGroups.filter((group) => group.isDefault).length;
    const zero = await add(1, { name: '组 A' });
    expect(defaults(zero)).toBe(0);
    const one = await add(2, { name: '组 B', isDefault: true });
    expect(defaults(one)).toBe(1);
    const second = one.ratioGroups.find((group) => group.name === '组 B')!;
    const cleared = await w.request('PATCH', `${MATRICES}/${matrix.id}/ratio-groups/${second.id}`, {
      ifMatch: 3,
      body: { isDefault: false },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(defaults((await cleared.json()) as MatrixView)).toBe(0);
    const again = await add(4, { name: '组 C', isDefault: true });
    expect(defaults(again)).toBe(1);
    const defaultId = again.ratioGroups.find((group) => group.isDefault)!.id;
    const removed = await w.request('DELETE', `${MATRICES}/${matrix.id}/ratio-groups/${defaultId}`, { ifMatch: 5 });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const after = (await w.read(matrix.id)).body;
    expect([after.ratioGroups.length, defaults(after)]).toEqual([2, 0]);
  });
});

describe('F-085 预置“绩效-潜力”对齐原站（Q-M0-157；DEC-389①）', () => {
  it('轴：X = 潜力、Y = 绩效；格子编号左下 1 沿对角线到右上 9，名称 / 背景 / 文字黑色按原站', async () => {
    const { preset, idOf } = await installed('trm-f085-preset');
    expect([preset.xFieldId, preset.yFieldId]).toEqual([idOf('potential_before'), idOf('appraisal_before')]);
    const cells = preset.cells as CellView[];
    expect(cells.map((cell) => cell.cellNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const cell of cells) {
      const expected = GRID[cell.cellNo]!;
      expect(
        { x: cell.xLevelNo, y: cell.yLevelNo, name: cell.name, color: cell.color.toUpperCase(), text: cell.textColor },
        `格子 ${cell.cellNo}`,
      ).toEqual({ x: expected.x, y: expected.y, name: expected.name, color: expected.color, text: '#000000' });
    }
  });

  it('导出顺序 9-7-8-5-4-6-2-3-1；绿化率默认关、没有格子计入', async () => {
    const { preset } = await installed('trm-f085-export');
    const cells = preset.cells as CellView[];
    const byExport = [...cells].sort((a, b) => a.exportOrder! - b.exportOrder!);
    expect(byExport.map((cell) => cell.cellNo)).toEqual(EXPORT_ORDER);
    expect(preset.greenRateReference).toBe(false);
    expect(cells.every((cell) => !cell.countsGreen)).toBe(true);
  });

  it('另一个预置（业绩-能力）不受影响：仍是按行编号的占位名称', async () => {
    const { w } = await installed('trm-f085-other');
    const other = (await w.list()).items.find((item) => item.code === 'achievement_capability')!;
    expect(other.cells.map((cell) => cell.name)).toContain('业绩低·能力低');
    expect((other.cells as CellView[]).every((cell) => cell.exportOrder === null)).toBe(true);
  });

  it('已安装的不被回补覆盖：租户改过格子 / 打开绿化率后再补装，原样不变', async () => {
    const { w, install, preset } = await installed('trm-f085-no-overwrite');
    const cells = (preset.cells as CellView[]).map((cell) =>
      cell.cellNo === 9 ? { ...cell, name: '租户自改名', countsGreen: true } : cell,
    );
    const edit = await w.request('PATCH', `${MATRICES}/${preset.id}`, {
      ifMatch: preset.revision,
      body: { greenRateReference: true, axisLevels: preset.axisLevels, cells },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const before = (await w.list()).items;
    await install();
    expect((await w.list()).items).toEqual(before);
  });
});

describe('F-085 格子的文字颜色、导出顺序与绿化率标记', () => {
  const withCells = (
    base: Record<string, unknown>,
    patch: (cell: Record<string, unknown>, index: number) => object,
  ) => ({
    ...base,
    cells: (base.cells as Record<string, unknown>[]).map((cell, index) => ({ ...cell, ...patch(cell, index) })),
  });

  it('文字颜色缺省黑色；可设 #RRGGBB；格式不对 400；导出顺序须整组给出且是 1..N 的排列', async () => {
    const w = await matrixWorld(testDb().db, 'trm-f085-cell-style');
    const base = matrixBody(await w.refs());
    const plain = await w.post(base);
    expect(plain.status, await plain.clone().text()).toBe(201);
    const plainCells = ((await plain.json()) as MatrixView).cells as CellView[];
    expect(plainCells.every((cell) => cell.textColor === '#000000' && cell.exportOrder === null)).toBe(true);

    const ordered = withCells(matrixBody(await w.refs()), (_cell, i) => ({
      textColor: '#111111',
      exportOrder: EXPORT_ORDER[i]!,
    }));
    const created = await w.post(ordered);
    expect(created.status, await created.clone().text()).toBe(201);
    const stored = ((await created.json()) as MatrixView).cells as CellView[];
    expect(stored.map((cell) => [cell.textColor, cell.exportOrder])[0]).toEqual(['#111111', 9]);

    const badColor = await w.post(withCells(matrixBody(await w.refs()), () => ({ textColor: 'black' })));
    expect([badColor.status, await errorCode(badColor)]).toEqual([400, 'VALIDATION_FAILED']);
    for (const orders of [
      [1, 1, 2, 3, 4, 5, 6, 7, 8],
      [1, 2, 3, 4, 5, 6, 7, 8, 10],
      [1, 2, 3, 4, 5, 6, 7, 8, undefined],
    ]) {
      const response = await w.post(
        withCells(matrixBody(await w.refs()), (_cell, i) =>
          orders[i] === undefined ? {} : { exportOrder: orders[i] },
        ),
      );
      expect([response.status, await reasonOf(response)], JSON.stringify(orders)).toEqual([
        400,
        'MATRIX_EXPORT_ORDER_INVALID',
      ]);
    }
  });

  it('绿化率：默认关；打开后可逐格标记是否计入（读回一致）', async () => {
    const w = await matrixWorld(testDb().db, 'trm-f085-green');
    const created = await w.create();
    expect(created.greenRateReference).toBe(false);
    const cells = created.cells.map((cell) => ({ ...cell, countsGreen: [7, 8, 9].includes(cell.cellNo) }));
    const response = await w.request('PATCH', `${MATRICES}/${created.id}`, {
      ifMatch: 1,
      body: { greenRateReference: true, axisLevels: created.axisLevels, cells },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as MatrixView;
    expect(view.greenRateReference).toBe(true);
    expect(view.cells.filter((cell) => cell.countsGreen).map((cell) => cell.cellNo)).toEqual([7, 8, 9]);
  });
});
