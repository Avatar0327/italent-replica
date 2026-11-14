/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-APV-F326-25 前端：矩阵结构编辑（F-326 F2b，设计 §4.2 / §6 / §8）。
 * 列定义、数据行添加 / 复制 / 删除 / 调序 / 批量删，本地草稿一次 PUT structure 保存，超上限即时提示；
 * 409 重读核对后显式重提、结果未知锁定按原命令重试。后端为按真实契约的合成后端（matrix-test-kit.ts）。
 */
import { MATRIX_LIMITS } from '@italent/domain';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE,
  catalog,
  click,
  clickNode,
  conditionColumn,
  fakeBackend,
  find,
  harness,
  head,
  ids,
  roleColumn,
  settle,
  text,
  type,
  type Column,
  type FakeBackend,
  type Row,
} from './matrix-test-kit.js';

const menus = vi.hoisted(() => ({ editable: true }));
vi.mock('../../foundation/Permissions.js', async (original) => ({
  ...(await original<object>()),
  usePermissions: () => ({
    menus: [{ key: 'settings', children: [{ key: 'matrix.manage', editable: menus.editable }] }],
  }),
}));

let backend: FakeBackend;
let ui: ReturnType<typeof harness>;
beforeEach(() => {
  menus.editable = true;
  backend = fakeBackend();
  ui = harness(backend);
});
afterEach(async () => ui.close());

const COND = '83000000-0000-4000-8000-000000000011';
/** 与合成引用里的 columnId 相同：这一列被流程引用，删除会被后端 409 拒绝。 */
const ROLE = '83000000-0000-4000-8000-000000000001';
const ROLE2 = '83000000-0000-4000-8000-000000000012';
const ROW1 = '89000000-0000-4000-8000-000000000001';
const ROW2 = '89000000-0000-4000-8000-000000000002';
const ROW3 = '89000000-0000-4000-8000-000000000003';
const [D1, D2] = catalog.departments.map((item) => item.id) as [string, string];
const [P1, P2] = catalog.people.map((item) => item.userId) as [string, string];

function seed(id: string = ids.a, columns?: Column[], rows?: Row[]) {
  backend.columns.set(
    id,
    columns ?? [conditionColumn(COND, '部门', 1), roleColumn(ROLE, '审批人', 2), roleColumn(ROLE2, '复核人', 3)],
  );
  backend.rows.set(
    id,
    rows ?? [
      { id: ROW1, seq: 1, cells: { [COND]: [D1!], [ROLE]: [P1!], [ROLE2]: [] } },
      { id: ROW2, seq: 2, cells: { [COND]: [D2!], [ROLE]: [P2!], [ROLE2]: [P1!] } },
      { id: ROW3, seq: 3, cells: { [COND]: [], [ROLE]: [], [ROLE2]: [] } },
    ],
  );
}
/** 结果未知会把命令钉在模块级存储里，锁定类用例各用一条独有矩阵（编码排在列表首位，默认选中）。 */
let lockSeq = 0;
function lone() {
  lockSeq += 1;
  const id = `81000000-0000-4000-8000-0000000006${String(lockSeq).padStart(2, '0')}`;
  backend.db.set(id, head({ id, code: `A0_STRUCT${lockSeq}`, name: '合成结构矩阵', revision: 3 }));
  seed(id);
  return id;
}

function structure() {
  const node = document.querySelector<HTMLElement>('.matrix-structure');
  if (!node) throw new Error('页面没有矩阵结构编辑区（.matrix-structure）');
  return node;
}
const columnRows = () => [...structure().querySelectorAll<HTMLElement>('.matrix-columns tbody tr.ant-table-row')];
const dataRows = () => [...structure().querySelectorAll<HTMLElement>('.matrix-rows tbody tr.ant-table-row')];
const headers = () =>
  [...structure().querySelectorAll('.matrix-rows thead th')].map((node) => text(node)).filter(Boolean);
const nameInput = (index: number) => columnRows()[index]!.querySelector<HTMLInputElement>('input[aria-label="列名"]');
const issues = () => text(structure().querySelector('.matrix-issues') ?? document.createElement('div'));
const puts = () => backend.writes.filter((write) => write.method === 'PUT');
const disabledIn = (label: string, scope: ParentNode = structure()) =>
  (find(label, scope) as HTMLButtonElement | undefined)?.disabled;
const save = () => click('保存结构', structure());
const seqs = () => dataRows().map((row) => text(row.querySelector('.matrix-seq')!));
async function check(row: HTMLElement, label: string) {
  const box = [...row.querySelectorAll('label')].find((node) => text(node) === label);
  await clickNode(box?.querySelector('input'));
}
/** 打开某个下拉框（antd Select 在 mousedown 时展开），在展开的那一个下拉里点选项。 */
async function choose(scope: Element, label: string) {
  const selector = scope.querySelector('.ant-select-selector');
  if (!selector) throw new Error('找不到下拉框');
  await act(async () => selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await settle();
  const open = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')].at(-1);
  const option = [...(open?.querySelectorAll<HTMLElement>('.ant-select-item-option') ?? [])].find(
    (node) => text(node) === label.replace(/\s/g, ''),
  );
  if (!option) throw new Error(`找不到选项：${label}`);
  await clickNode(option);
}
const cell = (row: number, column: number) => dataRows()[row]!.querySelectorAll('td.matrix-cell')[column]!;
const role = (id: string, key: string, name: string, allowMultiple = false) => ({
  id,
  key,
  kind: 'role',
  dimension: null,
  includeChildren: false,
  name,
  allowMultiple,
});

describe('AC-APV-F326-25 结构展示', () => {
  it('读矩阵详情：数据表按勾选、顺序、条件列、角色列、操作排列，单元格显示名称；列定义标出类型与维度', async () => {
    seed();
    await ui.render();
    expect(backend.reads.some((url) => url.pathname === `${BASE}/${ids.a}`)).toBe(true);
    expect(headers()).toEqual(['顺序', '部门', '审批人', '复核人', '操作']);
    expect(seqs()).toEqual(['1', '2', '3']);
    expect(text(dataRows()[0])).toContain('合成研发部');
    expect(text(dataRows()[0])).toContain('合成审批人甲');
    expect(text(dataRows()[1])).toContain('合成测试部');
    expect(text(dataRows()[1])).toContain('合成审批人乙');
    expect(columnRows().map((row) => text(row.querySelector('.matrix-kind')!))).toEqual([
      '审批条件',
      '审批角色',
      '审批角色',
    ]);
    expect(text(columnRows()[0])).toContain('部门');
    expect(nameInput(1)!.value).toBe('审批人');
    // 已保存列的维度建后只读（后端不拦截改维度，前端按最保守口径不给改）
    expect(columnRows()[0]!.querySelector('.ant-select')).toBeNull();
    expect(disabledIn('保存结构')).toBe(true);
  });

  it('没有写权限：只读展示列与行，不出现列、行操作与保存', async () => {
    menus.editable = false;
    seed();
    await ui.render();
    expect(headers()).toEqual(['顺序', '部门', '审批人', '复核人']);
    expect(text(dataRows()[0])).toContain('合成审批人甲');
    expect(structure().querySelectorAll('input')).toHaveLength(0);
    for (const label of ['添加审批条件列', '添加审批角色列', '添加行', '批量删除', '保存结构', '复制'])
      expect(find(label, structure())).toBeUndefined();
  });

  it('空矩阵：提示先添加列，添加行后出现空行', async () => {
    seed(ids.a, [], []);
    await ui.render();
    expect(text(structure())).toContain('暂无列');
    await click('添加行', structure());
    expect(seqs()).toEqual(['1']);
  });
});

describe('AC-APV-F326-25 列定义', () => {
  it('增删改列只改草稿，保存一次 PUT：条件列在前、短键按顺序、名称去首尾空格、已有列带 id', async () => {
    seed();
    await ui.render();
    await type(nameInput(1), '一级审批人');
    await click('添加审批条件列', structure());
    // 新条件列排在条件列之后；列名必填即时提示，保存不可用
    expect(columnRows().map((row) => text(row.querySelector('.matrix-kind')!))[1]).toBe('审批条件');
    expect(issues()).toContain('第2列：请输入列名');
    expect(disabledIn('保存结构')).toBe(true);
    await type(nameInput(1), ' 职位条件 ');
    await choose(columnRows()[1]!, '职位');
    await click('添加审批角色列', structure());
    await type(nameInput(4), '加签人');
    await check(columnRows()[4]!, '允许多人');
    await click('删除', columnRows()[0]);
    expect(headers()).toEqual(['顺序', '职位条件', '一级审批人', '复核人', '加签人', '操作']);
    expect(backend.writes).toHaveLength(0);

    await save();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.path).toBe(`${BASE}/${ids.a}/structure`);
    expect(puts()[0]!.key).toBeTruthy();
    expect(puts()[0]!.body).toEqual({
      revision: 3,
      columns: [
        {
          key: 'c1',
          kind: 'condition',
          dimension: 'position',
          includeChildren: false,
          name: '职位条件',
          allowMultiple: false,
        },
        role(ROLE, 'c2', '一级审批人'),
        role(ROLE2, 'c3', '复核人'),
        { key: 'c4', kind: 'role', dimension: null, includeChildren: false, name: '加签人', allowMultiple: true },
      ],
      rows: [
        { id: ROW1, cells: { c1: [], c2: [P1], c3: [], c4: [] } },
        { id: ROW2, cells: { c1: [], c2: [P2], c3: [P1], c4: [] } },
        { id: ROW3, cells: { c1: [], c2: [], c3: [], c4: [] } },
      ],
    });
    // 保存后按回执显示：新列有了 id，维度只读；保存回到不可用
    expect(backend.db.get(ids.a)!.revision).toBe(4);
    expect(headers()).toEqual(['顺序', '职位条件', '一级审批人', '复核人', '加签人', '操作']);
    expect(columnRows()[0]!.querySelector('.ant-select')).toBeNull();
    expect(disabledIn('保存结构')).toBe(true);
    expect(text(document.querySelector('.matrix-head')!)).toContain('合成矩阵甲');
  });

  it('部门条件列可含下级；改新列维度清空该列已选值；角色列不给维度', async () => {
    seed(ids.a, [], []);
    await ui.render();
    await click('添加审批条件列', structure());
    await type(nameInput(0), '部门');
    await check(columnRows()[0]!, '包含下级');
    await click('添加行', structure());
    await choose(cell(0, 0), '合成研发部');
    expect(text(cell(0, 0))).toContain('合成研发部');
    await choose(columnRows()[0]!, '职务');
    expect(text(cell(0, 0))).not.toContain('合成研发部');
    // 非部门维度不显示“包含下级”
    expect([...columnRows()[0]!.querySelectorAll('label')].some((node) => text(node) === '包含下级')).toBe(false);
    await click('添加审批角色列', structure());
    await type(nameInput(1), '审批人');
    expect(columnRows()[1]!.querySelector('.ant-select')).toBeNull();
    await save();
    expect(puts()[0]!.body.columns).toEqual([
      { key: 'c1', kind: 'condition', dimension: 'job', includeChildren: false, name: '部门', allowMultiple: false },
      { key: 'c2', kind: 'role', dimension: null, includeChildren: false, name: '审批人', allowMultiple: false },
    ]);
  });

  it('单元格选择：条件列按维度与租户业务日查候选，角色列查人员候选；单人角色列只能选 1 人', async () => {
    seed();
    await ui.render();
    await choose(cell(2, 0), '合成测试部');
    const sources = backend.lookups.filter((url) => url.pathname.endsWith('/source-candidates'));
    expect(sources.at(-1)!.searchParams.get('type')).toBe('department');
    expect(sources.at(-1)!.searchParams.get('asOf')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await choose(cell(2, 1), '合成审批人乙 · E002 · 合成测试部');
    expect(backend.lookups.at(-1)!.pathname).toMatch(/\/person-candidates$/);
    expect(text(cell(2, 1))).toContain('合成审批人乙');
    await save();
    expect((puts()[0]!.body.rows as { cells: unknown }[])[2]).toEqual({
      id: ROW3,
      cells: { c1: [D2], c2: [P2], c3: [] },
    });
  });
});

describe('AC-APV-F326-25 数据行', () => {
  it('复制、调序、添加、删除、批量删都只改草稿，顺序列跟着重排，最后一次 PUT 按行序提交', async () => {
    seed();
    await ui.render();
    await click('复制', dataRows()[0]);
    expect(seqs()).toEqual(['1', '2', '3', '4']);
    expect(text(dataRows()[1])).toContain('合成审批人甲');
    expect(disabledIn('上移', dataRows()[0])).toBe(true);
    expect(disabledIn('下移', dataRows()[3])).toBe(true);
    // 行 2（ROW2）下移到 ROW3 之后
    await click('下移', dataRows()[2]);
    expect(text(dataRows()[3])).toContain('合成审批人乙');
    await click('上移', dataRows()[3]);
    await click('下移', dataRows()[2]);
    await click('添加', dataRows()[0]);
    await click('添加行', structure());
    expect(seqs()).toEqual(['1', '2', '3', '4', '5', '6']);
    // 删除 ROW3（现在第 4 行），再勾选两条新空行批量删除
    await click('删除', dataRows()[3]);
    expect(disabledIn('批量删除')).toBe(true);
    await clickNode(dataRows()[1]!.querySelector('.ant-checkbox-input'));
    await clickNode(dataRows()[4]!.querySelector('.ant-checkbox-input'));
    await click('批量删除', structure());
    expect(seqs()).toEqual(['1', '2', '3']);
    expect(backend.writes).toHaveLength(0);

    await save();
    expect(puts()).toHaveLength(1);
    const body = puts()[0]!.body;
    expect(body.columns).toEqual([
      {
        id: COND,
        key: 'c1',
        kind: 'condition',
        dimension: 'department',
        includeChildren: false,
        name: '部门',
        allowMultiple: false,
      },
      role(ROLE, 'c2', '审批人'),
      role(ROLE2, 'c3', '复核人'),
    ]);
    expect(body.rows).toEqual([
      { id: ROW1, cells: { c1: [D1], c2: [P1], c3: [] } },
      { cells: { c1: [D1], c2: [P1], c3: [] } },
      { id: ROW2, cells: { c1: [D2], c2: [P2], c3: [P1] } },
    ]);
    expect(backend.rows.get(ids.a)).toHaveLength(3);
    expect(seqs()).toEqual(['1', '2', '3']);
  });

  it('撤销修改回到已保存的结构；改回原值不算修改', async () => {
    seed();
    await ui.render();
    await type(nameInput(1), '改名');
    expect(disabledIn('保存结构')).toBe(false);
    await type(nameInput(1), '审批人 ');
    expect(disabledIn('保存结构')).toBe(true);
    await click('添加行', structure());
    await click('删除', columnRows()[2]);
    await click('撤销修改', structure());
    expect(seqs()).toEqual(['1', '2', '3']);
    expect(headers()).toEqual(['顺序', '部门', '审批人', '复核人', '操作']);
    expect(backend.writes).toHaveLength(0);
  });
});

describe('AC-APV-F326-25 上限即时提示', () => {
  it(`条件列到 ${MATRIX_LIMITS.conditionColumns} 列、角色列到 ${MATRIX_LIMITS.roleColumns} 列后不能再加，并提示上限`, async () => {
    const conditions = Array.from({ length: MATRIX_LIMITS.conditionColumns - 1 }, (_, i) =>
      conditionColumn(`83000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, `条件${i + 1}`, i + 1),
    );
    const roles = Array.from({ length: MATRIX_LIMITS.roleColumns - 1 }, (_, i) =>
      roleColumn(`83000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`, `角色${i + 1}`, i + 10),
    );
    seed(ids.a, [...conditions, ...roles], []);
    await ui.render();
    expect(disabledIn('添加审批条件列')).toBe(false);
    await click('添加审批条件列', structure());
    await click('添加审批角色列', structure());
    expect(disabledIn('添加审批条件列')).toBe(true);
    expect(disabledIn('添加审批角色列')).toBe(true);
    expect(text(structure())).toContain(`审批条件列已达上限${MATRIX_LIMITS.conditionColumns}列`);
    expect(text(structure())).toContain(`审批角色列已达上限${MATRIX_LIMITS.roleColumns}列`);
  });

  it(`数据行到 ${MATRIX_LIMITS.rows} 行后添加、复制都不可用，并提示上限`, async () => {
    const rows = Array.from({ length: MATRIX_LIMITS.rows - 1 }, (_, i) => ({
      id: `89000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
      seq: i + 1,
      cells: { [COND]: [] },
    }));
    seed(ids.a, [conditionColumn(COND, '部门', 1)], rows);
    await ui.render();
    await click('复制', dataRows()[0]);
    expect(disabledIn('添加行')).toBe(true);
    expect(disabledIn('复制', dataRows()[0])).toBe(true);
    expect(disabledIn('添加', dataRows()[0])).toBe(true);
    expect(text(structure())).toContain(`数据行已达上限${MATRIX_LIMITS.rows}行`);
  });

  it('列名重复、超长标出列位置；单人角色列多人标出行列位置；有问题不能保存、不发请求', async () => {
    seed(
      ids.a,
      [conditionColumn(COND, '部门', 1), { ...roleColumn(ROLE, '审批人', 2), allowMultiple: true }],
      [
        { id: ROW1, seq: 1, cells: { [COND]: [D1!], [ROLE]: [] } },
        { id: ROW2, seq: 2, cells: { [COND]: [], [ROLE]: [P1!, P2!] } },
      ],
    );
    await ui.render();
    await type(nameInput(1), '部门');
    expect(issues()).toContain('第2列：列名不能重复');
    expect(columnRows()[1]!.classList.contains('matrix-invalid')).toBe(true);
    await type(nameInput(1), '审'.repeat(51));
    expect(issues()).toContain('第2列：列名不能超过50个字');
    await type(nameInput(1), '审批人');
    expect(issues()).toBe('');
    await check(columnRows()[1]!, '允许多人');
    expect(issues()).toContain('第2行「审批人」：单人角色列只能选1人');
    expect(dataRows()[1]!.classList.contains('matrix-invalid')).toBe(true);
    expect(disabledIn('保存结构')).toBe(true);
    await check(columnRows()[1]!, '允许多人');
    expect(issues()).toBe('');
    expect(backend.writes).toHaveLength(0);
  });

  it(`全部单元格合计超过 ${MATRIX_LIMITS.totalCellIds} 项即时提示，不能保存`, async () => {
    const perRow = MATRIX_LIMITS.roleCellIds;
    const rows = Array.from({ length: MATRIX_LIMITS.totalCellIds / perRow }, (_, r) => ({
      id: `89000000-0000-4000-8000-${String(r + 1000).padStart(12, '0')}`,
      seq: r + 1,
      cells: {
        [ROLE]: Array.from(
          { length: perRow },
          (_, i) => `9a000000-0000-4000-8000-${String(r * perRow + i).padStart(12, '0')}`,
        ),
      },
    }));
    seed(ids.a, [{ ...roleColumn(ROLE, '审批人', 1), allowMultiple: true }], rows);
    await ui.render();
    expect(issues()).toBe('');
    await click('复制', dataRows()[0]);
    expect(issues()).toContain(`全部单元格合计最多${MATRIX_LIMITS.totalCellIds}项`);
    expect(disabledIn('保存结构')).toBe(true);
  });
});

describe('AC-APV-F326-25 保存失败与恢复', () => {
  it('409 版本冲突：锁定草稿，重读最新版本核对差异后按新 revision 显式重提，换新命令', async () => {
    seed();
    await ui.render();
    await type(nameInput(1), '一级审批人');
    backend.state.fail = () => {
      backend.db.set(ids.a, { ...backend.db.get(ids.a)!, revision: 4 });
      backend.columns.set(
        ids.a,
        backend.columns.get(ids.a)!.map((column) => (column.id === ROLE2 ? { ...column, name: '他人复核人' } : column)),
      );
      return backend.error(409, 'REVISION_CONFLICT', '审批数据已变更，请刷新后显式重提');
    };
    await save();
    expect(text(structure())).toContain('版本冲突');
    expect(nameInput(1)!.disabled).toBe(true);
    expect(disabledIn('保存结构')).toBe(true);
    await click('重读最新版本', structure());
    expect(backend.reads.at(-1)!.pathname).toBe(`${BASE}/${ids.a}`);
    expect(text(structure())).toContain('他人复核人');
    await click('已核对差异，继续编辑', structure());
    expect(nameInput(1)!.disabled).toBe(false);
    expect(nameInput(1)!.value).toBe('一级审批人');
    expect(puts()).toHaveLength(1);
    await save();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.body.revision).toBe(4);
    expect(puts()[1]!.key).not.toBe(puts()[0]!.key);
    expect((puts()[1]!.body.columns as { name: string }[])[1]!.name).toBe('一级审批人');
    expect(backend.db.get(ids.a)!.revision).toBe(5);
  });

  it('结果未知：草稿与启停锁定，离开再回来仍锁定且保留草稿；按原命令重试用同一命令与正文', async () => {
    const id = lone();
    await ui.render();
    await type(nameInput(1), '未知改名');
    await click('添加行', structure());
    backend.state.fail = () => {
      throw new TypeError('network down');
    };
    await save();
    expect(text(structure())).toContain('结果待确认');
    expect(nameInput(1)!.disabled).toBe(true);
    expect(disabledIn('保存结构')).toBe(true);
    expect(disabledIn('停用', document.querySelector('.matrix-head')!)).toBe(true);

    await ui.remount();
    expect(text(structure())).toContain('结果待确认');
    expect(nameInput(1)!.value).toBe('未知改名');
    expect(seqs()).toEqual(['1', '2', '3', '4']);
    expect(nameInput(1)!.disabled).toBe(true);
    expect(puts()).toHaveLength(1);

    await click('按原命令重试', structure());
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.key).toBe(puts()[0]!.key);
    expect(puts()[1]!.body).toEqual(puts()[0]!.body);
    expect(backend.columns.get(id)![1]!.name).toBe('未知改名');
    expect(text(structure())).not.toContain('结果待确认');
    expect(nameInput(1)!.disabled).toBe(false);
  });

  it('回执 revision 不是原值 + 1：按结果未知锁定', async () => {
    const id = lone();
    await ui.render();
    await type(nameInput(1), '坏回执');
    backend.state.fail = () => Response.json({ ...backend.db.get(id)!, columns: [], rows: [], revision: 99 });
    await save();
    expect(text(structure())).toContain('结果待确认');
    expect(disabledIn('保存结构')).toBe(true);
  });

  it('删除被流程引用的角色列：显示服务端原因，不锁定，草稿保留可撤销', async () => {
    seed();
    await ui.render();
    await click('删除', columnRows()[1]);
    await save();
    expect(text(structure())).toContain('角色列正被流程引用，不能删除');
    expect(nameInput(0)!.disabled).toBe(false);
    expect(headers()).toEqual(['顺序', '部门', '复核人', '操作']);
    await click('撤销修改', structure());
    expect(headers()).toEqual(['顺序', '部门', '审批人', '复核人', '操作']);
    expect(backend.writes).toHaveLength(1);
  });

  it('后端 400 字段明细按路径标到行、列；按原因拒绝时显示服务端原因', async () => {
    seed();
    await ui.render();
    await type(nameInput(2), '复核');
    backend.state.fail = () =>
      Response.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: '请求字段不合法',
            details: [
              { path: ['rows', 1, 'cells', 'c2', 0], message: 'Invalid UUID' },
              { path: ['columns', 2, 'key'], message: 'Invalid key' },
            ],
          },
        },
        { status: 400 },
      );
    await save();
    expect(issues()).toContain('第2行「审批人」：InvalidUUID');
    expect(issues()).toContain('第3列：Invalidkey');
    expect(dataRows()[1]!.classList.contains('matrix-invalid')).toBe(true);
    expect(nameInput(0)!.disabled).toBe(false);

    backend.state.fail = () => backend.error(400, 'VALIDATION_FAILED', '矩阵结构超过上限', { reason: 'ROWS_LIMIT' });
    await save();
    expect(text(structure())).toContain('矩阵结构超过上限');
    expect(puts()).toHaveLength(2);
  });
});

/**
 * 第 2 轮（审查 P2-1）：409 后按 F-123 冲突规则在结构内部三方比较（原基线 / 最新版本 / 我的草稿）。
 * 甲只改列名；乙改了单元格、行顺序或列设置并先保存。重读后冲突区要列出乙的真实改动（可定位），
 * 乙改、甲没改的回填最新值，甲的改动保留；两边都改的列入冲突并保留甲的输入。确认后重提不覆盖乙的改动。
 */
describe('AC-APV-F326-25 409 冲突：结构三方核对与回填', () => {
  /** 失败用例会把冲突留在模块级存储里，每例各用一条独有矩阵（lone，默认选中、revision 3）。 */
  let id = '';
  /** 乙先保存：改库里的列 / 行并把 revision 推到 4，本次 PUT 得 409。 */
  function otherSaves(change: (columns: Column[], rows: Row[]) => { columns?: Column[]; rows?: Row[] }) {
    backend.state.fail = () => {
      const next = change(backend.columns.get(id)!, backend.rows.get(id)!);
      if (next.columns) backend.columns.set(id, next.columns);
      if (next.rows) backend.rows.set(id, next.rows);
      backend.db.set(id, { ...backend.db.get(id)!, revision: 4 });
      return backend.error(409, 'REVISION_CONFLICT', '审批数据已变更，请刷新后显式重提');
    };
  }
  /** 冲突核对表（CommandStatus 里列定义、数据行以外的那张表）逐行文本。 */
  const conflictRows = () =>
    [...structure().querySelectorAll<HTMLElement>('.ant-table')]
      .filter((node) => !node.closest('.matrix-columns, .matrix-rows'))
      .flatMap((node) => [...node.querySelectorAll<HTMLElement>('tbody tr.ant-table-row')])
      .map((row) => text(row));
  const conflictRow = (label: string) => conflictRows().find((row) => row.includes(label)) ?? '';
  const putRows = () => puts().at(-1)!.body.rows as { id?: string; cells: Record<string, string[]> }[];
  const putColumns = () => puts().at(-1)!.body.columns as { name: string; [key: string]: unknown }[];
  const checked = (row: HTMLElement, label: string) =>
    [...row.querySelectorAll('label')].find((node) => text(node) === label)?.querySelector('input')?.checked;
  /** 甲只改第 2 列列名，保存得 409，重读最新版本（尚未确认）。 */
  async function mineRenameThenReread() {
    await type(nameInput(1), '一级审批人');
    await save();
    expect(text(structure())).toContain('版本冲突');
    await click('重读最新版本', structure());
  }
  async function confirmAndSave() {
    await click('已核对差异，继续编辑', structure());
    await save();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.body.revision).toBe(4);
    expect(backend.db.get(id)!.revision).toBe(5);
  }

  it('乙改人员格：冲突区列出该格原值与最新值，回填乙的人选，甲的列名保留；重提不覆盖乙的人选', async () => {
    id = lone();
    await ui.render();
    otherSaves((_columns, rows) => ({
      rows: rows.map((row) => (row.id === ROW1 ? { ...row, cells: { ...row.cells, [ROLE]: [P2!] } } : row)),
    }));
    await mineRenameThenReread();
    const row = conflictRow('合成审批人乙');
    expect(row).toContain('第1行');
    expect(row).toContain('合成审批人甲');
    expect(text(cell(0, 1))).toContain('合成审批人乙');
    expect(nameInput(1)!.value).toBe('一级审批人');
    await confirmAndSave();
    expect(putRows()[0]).toEqual({ id: ROW1, cells: { c1: [D1], c2: [P2], c3: [] } });
    expect(putColumns()[1]!.name).toBe('一级审批人');
  });

  it('乙改条件格：冲突区列出该格原值与最新值，回填乙的条件，甲的列名保留；重提带乙的条件', async () => {
    id = lone();
    await ui.render();
    otherSaves((_columns, rows) => ({
      rows: rows.map((row) => (row.id === ROW2 ? { ...row, cells: { ...row.cells, [COND]: [D1!] } } : row)),
    }));
    await mineRenameThenReread();
    const row = conflictRow('第2行');
    expect(row).toContain('合成测试部');
    expect(row).toContain('合成研发部');
    expect(text(cell(1, 0))).toContain('合成研发部');
    expect(nameInput(1)!.value).toBe('一级审批人');
    await confirmAndSave();
    expect(putRows()[1]).toEqual({ id: ROW2, cells: { c1: [D1], c2: [P2], c3: [P1] } });
    expect(putColumns()[1]!.name).toBe('一级审批人');
  });

  it('乙调行顺序：冲突区列出行顺序变化，按乙的顺序回填，甲的列名保留；重提按乙的行序', async () => {
    id = lone();
    await ui.render();
    otherSaves((_columns, rows) => ({
      rows: rows.map((row) => ({ ...row, seq: row.id === ROW3 ? 0 : row.seq })),
    }));
    await mineRenameThenReread();
    expect(conflictRow('行顺序')).not.toBe('');
    expect(text(dataRows()[1])).toContain('合成审批人甲');
    expect(text(dataRows()[2])).toContain('合成审批人乙');
    expect(nameInput(1)!.value).toBe('一级审批人');
    await confirmAndSave();
    expect(putRows().map((row) => row.id)).toEqual([ROW3, ROW1, ROW2]);
    expect(putColumns()[1]!.name).toBe('一级审批人');
  });

  it('乙勾“包含下级”：冲突区列出该列设置变化并回填，甲的列名保留；重提带包含下级', async () => {
    id = lone();
    await ui.render();
    otherSaves((columns) => ({
      columns: columns.map((column) => (column.id === COND ? { ...column, includeChildren: true } : column)),
    }));
    await mineRenameThenReread();
    const row = conflictRow('包含下级');
    expect(row).toContain('部门');
    expect(row).toContain('是');
    expect(checked(columnRows()[0]!, '包含下级')).toBe(true);
    expect(nameInput(1)!.value).toBe('一级审批人');
    await confirmAndSave();
    expect(putColumns()[0]!.includeChildren).toBe(true);
    expect(putColumns()[1]!.name).toBe('一级审批人');
  });

  it('乙勾“允许多人”：冲突区列出该列设置变化并回填，甲的列名保留；重提带允许多人', async () => {
    id = lone();
    await ui.render();
    otherSaves((columns) => ({
      columns: columns.map((column) => (column.id === ROLE2 ? { ...column, allowMultiple: true } : column)),
    }));
    await mineRenameThenReread();
    const row = conflictRow('允许多人');
    expect(row).toContain('复核人');
    expect(row).toContain('是');
    expect(checked(columnRows()[2]!, '允许多人')).toBe(true);
    expect(nameInput(1)!.value).toBe('一级审批人');
    await confirmAndSave();
    expect(putColumns()[2]!.allowMultiple).toBe(true);
    expect(putColumns()[1]!.name).toBe('一级审批人');
  });

  it('两边都改同一格：列入冲突，显示原值、最新值和我的输入，保留我的人选；重提带我的人选', async () => {
    id = lone();
    await ui.render();
    otherSaves((_columns, rows) => ({
      rows: rows.map((row) => (row.id === ROW3 ? { ...row, cells: { ...row.cells, [ROLE]: [P2!] } } : row)),
    }));
    await choose(cell(2, 1), '合成审批人甲 · E001 · 合成研发部');
    await save();
    await click('重读最新版本', structure());
    const row = conflictRow('第3行');
    expect(row).toContain('两边都改');
    expect(row).toContain('合成审批人乙');
    expect(row).toContain('合成审批人甲');
    expect(text(cell(2, 1))).toContain('合成审批人甲');
    expect(text(cell(2, 1))).not.toContain('合成审批人乙');
    await confirmAndSave();
    expect(putRows()[2]).toEqual({ id: ROW3, cells: { c1: [], c2: [P1], c3: [] } });
  });
});
