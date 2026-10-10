/**
 * AC-TR-08-matrix · R3-T04 PR-B4 九宫格定义（设计 §2.2 matrices / position_fields / axis_levels / cells；TR-R31～R32、R35；D-20）：
 * - 位置字段占用：租户内唯一（before-before、after-after、两向 before-after、同一九宫格 before = after 都 409），
 *   保存命令恰两行（缺任一角色 400 MATRIX_POSITION_FIELDS_INCOMPLETE），位置字段须是“位置”分组的数值字段；
 * - 轴 / 分段 / 格子的整组校验（单选轴按选项值分段、数值轴按递增下界分段；格子是完整网格）；
 * - If-Match revision（409）、幂等键、严格结构；被引用不可删、预置不可删；三种写入都写数据变更日志（同事务）。
 * 负向用例断言具体响应码，并前后各读一次对比，证明业务数据未被改动。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('matrix', async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_REFERRER' : null));
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

describe('九宫格新建与读取（TR-R31）', () => {
  it('新建返回完整聚合；列表按排序号、详情带 ETag；标识大小写不敏感；其他租户看不到', async () => {
    const w = await matrixWorld(testDb().db, 'trm-crud');
    const other = await matrixWorld(testDb().db, 'trm-crud-other');
    const later = await w.create({ sortNo: 2, xDraggable: true, placementSource: 'after' });
    const soon = await w.create({ sortNo: 1 });
    expect(later).toMatchObject({
      revision: 1,
      enabled: true,
      preset: false,
      xDraggable: true,
      yDraggable: false,
      placementSource: 'after',
      greenRateReference: false,
      zFieldId: null,
      createdBy: w.as.user,
      ratioGroups: [],
    });
    expect(later.positionFields.map((row) => row.role).sort()).toEqual(['after', 'before']);
    expect(later.axisLevels).toHaveLength(6);
    expect(later.cells).toHaveLength(9);
    expect(soon.placementSource).toBe('after_else_before');
    expect((await w.list()).items.map((item) => item.id)).toEqual([soon.id, later.id]);
    const detail = await w.request('GET', `${MATRICES}/${soon.id.toUpperCase()}`);
    expect(detail.headers.get('etag')).toBe('"1"');
    expect(await detail.json()).toEqual(soon);
    expect((await other.read(soon.id)).status).toBe(404);
    expect((await other.list()).items).toEqual([]);
  });

  it('编码与名称租户唯一 409；多余字段 400；失败不落库', async () => {
    const w = await matrixWorld(testDb().db, 'trm-unique');
    const first = await w.create();
    const refs = await w.refs();
    for (const extra of [{ code: first.code }, { name: first.name }]) {
      const dup = await w.post(matrixBody(await w.refs(), extra));
      expect([dup.status, await reasonOf(dup)], JSON.stringify(extra)).toEqual([409, 'MATRIX_DUPLICATE']);
    }
    const extra = await w.post(matrixBody(refs, { unknown: 1 }));
    expect([extra.status, await errorCode(extra)]).toEqual([400, 'VALIDATION_FAILED']);
    const zNotFound = await w.post(matrixBody(refs, { zFieldId: '00000000-0000-4000-8000-000000000000' }));
    expect([zNotFound.status, await errorCode(zNotFound)]).toEqual([404, 'NOT_FOUND']);
    expect((await w.list()).items.map((item) => item.id)).toEqual([first.id]);
  });
});

describe('位置字段占用（TR-R31；D-20；AC-TR-08）', () => {
  it.each([
    ['before-before', 'before', 'before'],
    ['after-after', 'after', 'after'],
    ['before-after（交叉）', 'before', 'after'],
    ['after-before（交叉）', 'after', 'before'],
  ] as const)('两个九宫格占用同一位置字段 · %s：409，数据不变', async (_name, firstRole, secondRole) => {
    const w = await matrixWorld(testDb().db, `trm-occupy-${firstRole}-${secondRole}`);
    const first = await w.create();
    const claimed = first.positionFields.find((row) => row.role === firstRole)!.fieldId;
    const fresh = await w.positionField();
    const roles = secondRole === 'before' ? [claimed, fresh.id] : [fresh.id, claimed];
    const refs = { ...(await w.refs()), before: roles[0]!, after: roles[1]! };
    const response = await w.post(matrixBody(refs));
    expect([response.status, await reasonOf(response)]).toEqual([409, 'MATRIX_POSITION_FIELD_IN_USE']);
    expect((await w.list()).items.map((item) => item.id)).toEqual([first.id]);
    expect((await w.read(first.id)).body).toEqual(first);
  });

  it('同一九宫格 before 与 after 指向同一字段：409', async () => {
    const w = await matrixWorld(testDb().db, 'trm-occupy-same');
    const refs = await w.refs();
    const response = await w.post(matrixBody({ ...refs, after: refs.before }));
    expect([response.status, await reasonOf(response)]).toEqual([409, 'MATRIX_POSITION_FIELD_IN_USE']);
    expect((await w.list()).items).toEqual([]);
  });

  it('保存命令恰两行：缺任一角色、重复角色 400 MATRIX_POSITION_FIELDS_INCOMPLETE，超过两行 400；不落库', async () => {
    const w = await matrixWorld(testDb().db, 'trm-exact-two');
    const refs = await w.refs();
    const extra = (await w.positionField()).id;
    const cases: Record<string, unknown>[] = [
      { positionFields: [] },
      { positionFields: [{ role: 'before', fieldId: refs.before }] },
      { positionFields: [{ role: 'after', fieldId: refs.after }] },
      {
        positionFields: [
          { role: 'before', fieldId: refs.before },
          { role: 'before', fieldId: refs.after },
        ],
      },
    ];
    for (const body of cases) {
      const response = await w.post(matrixBody(refs, body));
      expect([response.status, await reasonOf(response)], JSON.stringify(body)).toEqual([
        400,
        'MATRIX_POSITION_FIELDS_INCOMPLETE',
      ]);
    }
    const three = await w.post(
      matrixBody(refs, {
        positionFields: [
          { role: 'before', fieldId: refs.before },
          { role: 'after', fieldId: refs.after },
          { role: 'after', fieldId: extra },
        ],
      }),
    );
    expect([three.status, await errorCode(three)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await w.list()).items).toEqual([]);
    const created = await w.create({}, refs);
    const patch = await w.request('PATCH', `${MATRICES}/${created.id}`, {
      ifMatch: 1,
      body: { positionFields: [{ role: 'before', fieldId: extra }] },
    });
    expect([patch.status, await reasonOf(patch)]).toEqual([400, 'MATRIX_POSITION_FIELDS_INCOMPLETE']);
    expect((await w.read(created.id)).body).toEqual(created);
  });

  it('位置字段必须是“位置”分组的数值字段；新引用已停用的字段 400 MATRIX_FIELD_DISABLED', async () => {
    const w = await matrixWorld(testDb().db, 'trm-position-kind');
    const refs = await w.refs();
    const score = await w.numberField();
    const off = await w.positionField();
    expect((await w.request('PATCH', `/fields/${off.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(200);
    for (const [before, reason] of [
      [(await w.optionField()).id, 'MATRIX_POSITION_FIELD_KIND'],
      [score.id, 'MATRIX_POSITION_FIELD_KIND'],
      [off.id, 'MATRIX_FIELD_DISABLED'],
    ] as const) {
      const response = await w.post(matrixBody({ ...refs, before }));
      expect([response.status, await reasonOf(response)], reason).toEqual([400, reason]);
    }
    expect((await w.list()).items).toEqual([]);
  });

  it('改位置字段释放旧字段：旧字段可被另一个九宫格占用；换到他人占用的字段 409，数据不变', async () => {
    const w = await matrixWorld(testDb().db, 'trm-release');
    const a = await w.create();
    const b = await w.create();
    const aBefore = a.positionFields.find((row) => row.role === 'before')!.fieldId;
    const bAfter = b.positionFields.find((row) => row.role === 'after')!.fieldId;
    const fresh = await w.positionField();
    const taken = await w.request('PATCH', `${MATRICES}/${a.id}`, {
      ifMatch: 1,
      body: {
        positionFields: [
          { role: 'before', fieldId: aBefore },
          { role: 'after', fieldId: bAfter },
        ],
      },
    });
    expect([taken.status, await reasonOf(taken)]).toEqual([409, 'MATRIX_POSITION_FIELD_IN_USE']);
    expect((await w.read(a.id)).body).toEqual(a);
    const moved = await w.request('PATCH', `${MATRICES}/${a.id}`, {
      ifMatch: 1,
      body: {
        positionFields: [
          { role: 'before', fieldId: fresh.id },
          { role: 'after', fieldId: a.positionFields.find((row) => row.role === 'after')!.fieldId },
        ],
      },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const reuse = await w.request('PATCH', `${MATRICES}/${b.id}`, {
      ifMatch: 1,
      body: {
        positionFields: [
          { role: 'before', fieldId: aBefore },
          { role: 'after', fieldId: bAfter },
        ],
      },
    });
    expect(reuse.status, await reuse.clone().text()).toBe(200);
  });

  it('被九宫格引用的字段不能删除（FIELD_IN_USE，referrer = MATRIX），九宫格删除后可删', async () => {
    const w = await matrixWorld(testDb().db, 'trm-field-guard');
    const matrix = await w.create();
    for (const fieldId of [matrix.xFieldId, matrix.positionFields[0]!.fieldId]) {
      const response = await w.request('DELETE', `/fields/${fieldId}`, { ifMatch: 1 });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { details: { reason: 'FIELD_IN_USE', referrer: 'MATRIX' } },
      });
    }
    expect((await w.read(matrix.id)).body).toEqual(matrix);
    expect((await w.request('DELETE', `${MATRICES}/${matrix.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.request('DELETE', `/fields/${matrix.xFieldId}`, { ifMatch: 1 })).status).toBe(200);
  });
});

describe('轴、分段与格子（TR-R31）', () => {
  const bad: [string, (m: MatrixView, ids: { text: string }) => Record<string, unknown>, string][] = [
    ['X 与 Y 是同一个字段', (m) => ({ yFieldId: m.xFieldId }), 'MATRIX_AXIS_SAME_FIELD'],
    ['轴字段不是等级维度（单选）字段', (_m, ids) => ({ xFieldId: ids.text }), 'MATRIX_AXIS_FIELD_KIND'],
    [
      '单选轴的分段引用了不存在的选项值',
      (m) => ({
        axisLevels: m.axisLevels.map((l) => (l.axis === 'x' && l.levelNo === 1 ? { ...l, optionValues: ['9'] } : l)),
      }),
      'MATRIX_LEVELS_INVALID',
    ],
    [
      '单选轴的选项值被两个分段重复使用',
      (m) => ({
        axisLevels: m.axisLevels.map((l) => (l.axis === 'x' && l.levelNo === 2 ? { ...l, optionValues: ['1'] } : l)),
      }),
      'MATRIX_LEVELS_INVALID',
    ],
    [
      '分段少于两段',
      (m) => ({ axisLevels: m.axisLevels.filter((l) => l.axis !== 'y' || l.levelNo === 1) }),
      'MATRIX_LEVELS_INVALID',
    ],
    [
      '分段序号不连续',
      (m) => ({ axisLevels: m.axisLevels.map((l) => (l.axis === 'y' && l.levelNo === 3 ? { ...l, levelNo: 4 } : l)) }),
      'MATRIX_LEVELS_INVALID',
    ],
    ['格子缺一个（网格不完整）', (m) => ({ cells: m.cells.slice(1) }), 'MATRIX_CELLS_INCOMPLETE'],
    [
      '格子编号重复',
      (m) => ({ cells: m.cells.map((c, i) => (i === 1 ? { ...c, cellNo: m.cells[0]!.cellNo } : c)) }),
      'MATRIX_CELLS_INCOMPLETE',
    ],
    [
      '两个格子落在同一行列',
      (m) => ({ cells: m.cells.map((c, i) => (i === 1 ? { ...c, xLevelNo: 1, yLevelNo: 1 } : c)) }),
      'MATRIX_CELLS_INCOMPLETE',
    ],
  ];

  it.each(bad)('新建与修改都拒绝 · %s：400，数据不变', async (_name, mutate, reason) => {
    const w = await matrixWorld(testDb().db, `trm-shape-${reason}`);
    const created = await w.create();
    const text = { text: (await w.textField()).id };
    const whole = (m: MatrixView) => ({ axisLevels: m.axisLevels, cells: m.cells });
    const edit = await w.request('PATCH', `${MATRICES}/${created.id}`, {
      ifMatch: 1,
      body: { ...whole(created), ...mutate(created, text) },
    });
    expect([edit.status, await reasonOf(edit)]).toEqual([400, reason]);
    const base = matrixBody(await w.refs()) as unknown as MatrixView;
    const fresh = await w.post({ ...base, ...mutate(base, text) });
    expect([fresh.status, await reasonOf(fresh)]).toEqual([400, reason]);
    expect((await w.read(created.id)).body).toEqual(created);
    expect((await w.list()).items).toHaveLength(1);
  });

  it('F-085（DEC-389①）轴只能是等级维度（单选）字段：数值字段新建 / 修改都 400 MATRIX_AXIS_FIELD_KIND，数据不变', async () => {
    const w = await matrixWorld(testDb().db, 'trm-numeric-axis');
    const score = (await w.numberField()).id;
    const refs = await w.refs();
    for (const axisField of [{ xFieldId: score }, { yFieldId: score }]) {
      const response = await w.post(matrixBody(refs, axisField));
      expect([response.status, await reasonOf(response)]).toEqual([400, 'MATRIX_AXIS_FIELD_KIND']);
    }
    expect((await w.list()).items).toEqual([]);
    const created = await w.create({}, refs);
    const patch = await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 1, body: { xFieldId: score } });
    expect([patch.status, await reasonOf(patch)]).toEqual([400, 'MATRIX_AXIS_FIELD_KIND']);
    expect((await w.read(created.id)).body).toEqual(created);
  });

  it('F-085 数值轴的“下界”已删除（DEC-403）：带 lowerBound 的分段 400 VALIDATION_FAILED', async () => {
    const w = await matrixWorld(testDb().db, 'trm-no-lower-bound');
    const base = matrixBody(await w.refs());
    const levels = (base.axisLevels as Record<string, unknown>[]).map((level, i) =>
      i === 0 ? { ...level, lowerBound: 60 } : level,
    );
    const response = await w.post({ ...base, axisLevels: levels });
    expect([response.status, await errorCode(response)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await w.list()).items).toEqual([]);
  });

  it('整组替换：轴分段与格子必须同时提交；被比例规则引用的格子不能删（409 MATRIX_CELL_IN_USE）', async () => {
    const w = await matrixWorld(testDb().db, 'trm-replace');
    const created = await w.create();
    const only = await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 1, body: { cells: created.cells } });
    expect([only.status, await errorCode(only)]).toEqual([400, 'VALIDATION_FAILED']);
    const rename = created.cells.map((c) => (c.cellNo === 9 ? { ...c, name: '明星', countsGreen: true } : c));
    const ok = await w.request('PATCH', `${MATRICES}/${created.id}`, {
      ifMatch: 1,
      body: { axisLevels: created.axisLevels, cells: rename },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const updated = (await ok.json()) as MatrixView;
    expect(updated.cells.find((c) => c.cellNo === 9)).toMatchObject({ name: '明星', countsGreen: true });
    const group = await w.request('POST', `${MATRICES}/${created.id}/ratio-groups`, {
      ifMatch: updated.revision,
      body: {
        name: '组',
        controlScope: 'project_meeting',
        controlMode: 'warn',
        rules: [{ operator: 'lte', pctLow: 20, cellNos: [9] }],
      },
    });
    expect(group.status, await group.clone().text()).toBe(201);
    const withGroup = (await group.json()) as MatrixView;
    const shrink = {
      axisLevels: created.axisLevels.filter((l) => l.levelNo !== 3),
      cells: created.cells.filter((c) => c.xLevelNo <= 2 && c.yLevelNo <= 2),
    };
    const blocked = await w.request('PATCH', `${MATRICES}/${created.id}`, {
      ifMatch: withGroup.revision,
      body: shrink,
    });
    expect(blocked.status).toBe(409);
    expect(await reasonOf(blocked)).toBe('MATRIX_CELL_IN_USE');
    expect((await w.read(created.id)).body).toEqual(withGroup);
  });
});

describe('修改、幂等、删除与审计', () => {
  it('修改要求当前 revision；缺失 400；同键同内容重放首次结果，异内容 409；未提交字段保留', async () => {
    const w = await matrixWorld(testDb().db, 'trm-revision');
    const created = await w.create({ xDraggable: true });
    const stale = await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 7, body: { name: '改' } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    expect(await errorCode(await w.request('PATCH', `${MATRICES}/${created.id}`, { body: { name: '改' } }))).toBe(
      'REVISION_REQUIRED',
    );
    expect((await w.read(created.id)).body).toEqual(created);
    const options = { ifMatch: 1, idempotencyKey: 'trm-patch-1', body: { name: '改名', enabled: false } };
    const first = await w.request('PATCH', `${MATRICES}/${created.id}`, options);
    expect(first.status).toBe(200);
    const updated = (await first.json()) as MatrixView;
    expect(updated).toMatchObject({ revision: 2, name: '改名', enabled: false, xDraggable: true });
    expect(updated.cells).toEqual(created.cells);
    const replay = await w.request('PATCH', `${MATRICES}/${created.id}`, options);
    expect([replay.status, await replay.json()]).toEqual([200, updated]);
    const conflict = await w.request('PATCH', `${MATRICES}/${created.id}`, { ...options, body: { name: '另一个' } });
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    for (const body of [{ code: 'x' }, { preset: true }, { revision: 9 }]) {
      const response = await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 2, body });
      expect([response.status, await errorCode(response)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await w.read(created.id)).body).toEqual(updated);
  });

  it('被引用不可删（MATRIX_IN_USE，数据不变），可停用；未引用可删，级联删除子数据并释放位置字段', async () => {
    const w = await matrixWorld(testDb().db, 'trm-delete');
    const created = await w.create();
    referenced.add(created.id);
    const blocked = await w.request('DELETE', `${MATRICES}/${created.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'MATRIX_IN_USE', referrer: 'TEST_REFERRER' } },
    });
    expect((await w.read(created.id)).body).toEqual(created);
    expect(
      (await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 1, body: { enabled: false } })).status,
    ).toBe(200);
    referenced.delete(created.id);
    const removed = await w.request('DELETE', `${MATRICES}/${created.id}`, { ifMatch: 2 });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: created.id, cells: created.cells });
    expect((await w.read(created.id)).status).toBe(404);
    const refs = {
      x: created.xFieldId,
      y: created.yFieldId,
      before: created.positionFields[0]!.fieldId,
      after: created.positionFields[1]!.fieldId,
    };
    expect((await w.post(matrixBody(refs))).status).toBe(201);
  });

  it('新增 / 修改 / 删除都写数据变更日志，修改只记改动字段，删除带快照', async () => {
    const w = await matrixWorld(testDb().db, 'trm-audit');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const created = await w.create();
    await w.request('PATCH', `${MATRICES}/${created.id}`, { ifMatch: 1, body: { name: '审计改名' } });
    await w.request('DELETE', `${MATRICES}/${created.id}`, { ifMatch: 2 });
    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_REVIEW_OBJECTS.matrix.code, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete', 'update']);
    for (const entry of items) expect(entry).toMatchObject({ app: '人才盘点', objectId: created.id });
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['name']);
    const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({ id: created.id, name: '审计改名' });
    const made = items.find((entry) => entry.operation === 'create')!;
    expect(made.changes.map((change) => change.field)).toEqual(
      expect.arrayContaining(['cells', 'positionFields', 'axisLevels', 'code', 'name']),
    );
  });
});
