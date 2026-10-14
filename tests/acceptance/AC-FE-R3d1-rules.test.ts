/**
 * FE-R3d-1 继任管理页面的纯规则（docs/02_业务建模/27 §1.1、§5.5、§5.6；Q-M0-178）。
 * 页面渲染由冒烟覆盖；这里锁定校验、请求体组装、菜单与地图结构这些逻辑。
 */
import { describe, expect, it } from 'vitest';
import type { ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import {
  assignBody,
  assignLatest,
  createRecordBody,
  END_RECEIPT,
  endCommand,
  endReceipt,
  mapForest,
  orgMapItems,
  preferenceLatest,
  preferenceReceipt,
  PREFS_RECEIPT,
  recordDateErrors,
  recordQuery,
  ruleLines,
  settingsMenu,
} from '../../apps/web/src/succession/rules.js';

const TODAY = '2026-10-13';

describe('AC-FE-R3d1 继任记录日期校验（SC-R2）', () => {
  it('开始、结束不得晚于租户今天，结束不得早于开始', () => {
    expect(recordDateErrors({ startDate: '2026-10-13' }, TODAY)).toEqual({});
    expect(recordDateErrors({ startDate: '2026-10-14' }, TODAY)).toEqual({ startDate: 'startFuture' });
    expect(recordDateErrors({ startDate: '2026-10-01', endDate: '2026-10-14' }, TODAY)).toEqual({
      endDate: 'endFuture',
    });
    expect(recordDateErrors({ startDate: '2026-10-05', endDate: '2026-10-01' }, TODAY)).toEqual({
      endDate: 'endBeforeStart',
    });
    expect(recordDateErrors({ startDate: '2026-10-05', endDate: null }, TODAY)).toEqual({});
  });
  it('租户今天未知时不放行（fail-closed）', () => {
    expect(recordDateErrors({ startDate: '2026-10-01' }, undefined)).toEqual({ startDate: 'todayUnknown' });
  });
});

describe('AC-FE-R3d1 新增继任记录请求体', () => {
  it('职位继任只带目标职位，继任者取选择值，空值不发送', () => {
    expect(
      createRecordBody('position', {
        targetId: 'pos-1',
        successor: { value: 'emp-1', label: '合成甲' },
        readinessId: undefined,
        backupType: 'principal',
        startDate: '2026-10-01',
        endDate: null,
        endReason: '  ',
      }),
    ).toEqual({
      successionType: 'position',
      targetPositionId: 'pos-1',
      successorEmployeeId: 'emp-1',
      backupType: 'principal',
      startDate: '2026-10-01',
    });
  });
  it('组织继任只带目标组织；结束原因去掉首尾空白', () => {
    expect(
      createRecordBody('org', {
        targetId: 'org-1',
        successor: 'emp-2',
        readinessId: 'ready-1',
        startDate: '2026-09-01',
        endDate: '2026-10-01',
        endReason: ' 调岗 ',
      }),
    ).toEqual({
      successionType: 'org',
      targetOrgId: 'org-1',
      successorEmployeeId: 'emp-2',
      readinessId: 'ready-1',
      startDate: '2026-09-01',
      endDate: '2026-10-01',
      endReason: '调岗',
    });
  });
});

describe('AC-FE-R3d1 批量结束（SC-R3）', () => {
  it('逐条带期望版本；已结束的记录不进入命令', () => {
    expect(
      endCommand(
        [
          { id: 'a', revision: 2, status: 'active' },
          { id: 'b', revision: 5, status: 'ended' },
        ],
        '2026-10-13',
        '',
      ),
    ).toEqual({ items: [{ id: 'a', expectedRevision: 2 }], endDate: '2026-10-13' });
    expect(endCommand([{ id: 'a', revision: 1, status: 'active' }], '2026-10-12', '离职')).toEqual({
      items: [{ id: 'a', expectedRevision: 1 }],
      endDate: '2026-10-12',
      endReason: '离职',
    });
  });
  it('超过 200 条或没有可结束的记录时拒绝组装', () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({ id: `r${index}`, revision: 1, status: 'active' }));
    expect(() => endCommand(rows, '2026-10-13', '')).toThrow('endTooMany');
    expect(() => endCommand([{ id: 'b', revision: 1, status: 'ended' }], '2026-10-13', '')).toThrow('endNone');
  });
});

describe('AC-FE-R3d1 风险等级 / 健康度赋值（Q-M0-178）', () => {
  it('按规则计算发送 null，手动赋值必须选择等级', () => {
    expect(assignBody('rule', 'level-1')).toEqual({ levelId: null });
    expect(assignBody('manual', 'level-1')).toEqual({ levelId: 'level-1' });
    expect(() => assignBody('manual', undefined)).toThrow('levelRequired');
  });
});

describe('AC-FE-R3d1 继任地图结构（SC-R8）', () => {
  it('父节点不在结果里的都作为根，子节点按返回顺序挂接', () => {
    const forest = mapForest([
      { id: 'a', parentId: null, name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
      { id: 'c', parentId: 'hidden', name: 'C' },
      { id: 'd', parentId: 'a', name: 'D' },
    ]);
    expect(forest.map((node) => node.item.id)).toEqual(['a', 'c']);
    expect(forest[0]!.children.map((node) => node.item.id)).toEqual(['b', 'd']);
  });
  it('数据成环时不死循环，每个节点只出现一次', () => {
    const forest = mapForest([
      { id: 'a', parentId: 'b', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
    ]);
    const ids: string[] = [];
    const walk = (nodes: typeof forest) =>
      nodes.forEach((node) => {
        ids.push(node.item.id);
        walk(node.children);
      });
    walk(forest);
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});

describe('AC-FE-R3d1 列表查询只带可见字段的筛选', () => {
  it('隐藏字段的筛选不发送，避免 FILTER_FIELD_HIDDEN', () => {
    const visible = (field: string) => field !== 'successorEmployeeId';
    expect(
      recordQuery({ type: 'position', page: 2, pageSize: 15, status: 'all', successorEmployeeId: 'e' }, visible),
    ).toBe('page=2&pageSize=15&successionType=position&status=all');
    expect(recordQuery({ type: 'org', page: 1, pageSize: 50, successorEmployeeId: 'e' }, () => true)).toBe(
      'page=1&pageSize=50&successionType=org&status=active&successorEmployeeId=e',
    );
  });
  it('状态、继任类型字段隐藏时这两个参数也不发送', () => {
    const visible = (field: string) => !['status', 'successionType'].includes(field);
    expect(recordQuery({ type: 'org', page: 1, pageSize: 15, status: 'all' }, visible)).toBe('page=1&pageSize=15');
  });
});

describe('AC-FE-R3d1 真实回执形状（第 2 轮）', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  it('批量结束回执 {items} 逐条对上提交的记录才算成功', () => {
    expect(endReceipt({ items: [{ id: 'b' }, { id: 'a' }] }, rows)).toEqual({ id: END_RECEIPT });
    expect(() => endReceipt({ id: 'a' }, rows)).toThrow();
    expect(() => endReceipt({ items: [{ id: 'a' }] }, rows)).toThrow();
    expect(() => endReceipt({ items: [{ id: 'a' }, { id: 'x' }] }, rows)).toThrow();
    expect(() => endReceipt(null, rows)).toThrow();
  });
  const view = {
    rootOrgId: null,
    depth: 3,
    hiddenOrgIds: [],
    showKeyPositions: false,
    showPositionsWithoutSuccessor: true,
    revision: 4,
  };
  it('偏好回执没有 id：按真实形状核对后给出固定键，版本取回执', () => {
    expect(preferenceReceipt(view)).toEqual({ id: PREFS_RECEIPT });
    expect(() => preferenceReceipt({ ...view, revision: undefined })).toThrow();
    expect(preferenceLatest(view)).toMatchObject({ id: PREFS_RECEIPT, revision: 4 });
  });
  it('赋值重读按节点取结果行，含组织下的关键职位；未评定时版本为 0', () => {
    const map = {
      items: [
        { id: 'o', name: 'O', parentId: null, health: { levelId: 'h', revision: 3 } },
        { id: 'p', name: 'P', parentId: null, keyPositions: [{ id: 'k', name: 'K', parentId: 'o' }] },
      ],
    };
    expect(assignLatest(map, 'o', 'org')).toEqual({ id: 'o', revision: 3, values: { mode: 'manual', levelId: 'h' } });
    expect(assignLatest(map, 'k', 'position')).toEqual({
      id: 'k',
      revision: 0,
      values: { mode: 'rule', levelId: undefined },
    });
    expect(() => assignLatest(map, 'x', 'org')).toThrow();
  });
});

describe('AC-FE-R3d1 地图数据与规则展示（第 2 轮）', () => {
  it('组织地图把 keyPositions[] 展开成所属组织下的关键职位卡', () => {
    const items = orgMapItems([
      { id: 'o', name: 'O', parentId: null, keyPositions: [{ id: 'k', name: 'K', parentId: null }] },
    ]);
    expect(items.map((item) => [item.id, item.parentId, !!item.keyPosition])).toEqual([
      ['o', null, false],
      ['k', 'o', true],
    ]);
  });
  it('规则条件行与表达式按原站用语展示，未知枚举原样显示', () => {
    expect(
      ruleLines({
        expression: '1 and 2',
        rows: [
          { rowNo: 1, subject: 'incumbent', measure: 'count', comparator: 'eq', threshold: 0 },
          {
            rowNo: 2,
            population: 'all',
            measure: 'green_rate',
            comparator: 'between',
            threshold: 10,
            thresholdHigh: 20,
            isPercent: true,
          },
          { rowNo: 3, field: { label: '年龄' }, operator: 'lt', values: [45] },
          { rowNo: 4, measure: 'new_kind', comparator: 'gt', threshold: 1 },
        ],
      }),
    ).toEqual({
      expression: '1 and 2',
      rows: ['1. 现任人员 人数 等于 0', '2. 全部人员 绿化率 介于 10% ~ 20%', '3. 年龄 小于 45', '4. new_kind 大于 1'],
    });
    expect(ruleLines(null)).toBeUndefined();
    expect(ruleLines({ expression: '', rows: [] })).toBeUndefined();
  });
});

describe('AC-FE-R3d1 第 3 轮：回执严格性、偏好全量与规则限定条件', () => {
  const view = {
    rootOrgId: null,
    depth: 3,
    hiddenOrgIds: ['org-9'],
    showKeyPositions: true,
    showPositionsWithoutSuccessor: true,
    revision: 4,
  };
  it('批量结束回执里重复的 id 不能当作覆盖全部记录', () => {
    expect(() => endReceipt({ items: [{ id: 'a' }, { id: 'a' }] }, [{ id: 'a' }, { id: 'b' }])).toThrow();
  });
  it('偏好回执按真实 DTO 逐项核对：缺项、类型不符、层级越界都判无效', () => {
    expect(preferenceReceipt(view)).toEqual({ id: PREFS_RECEIPT });
    const { hiddenOrgIds: _hidden, ...withoutHidden } = view;
    for (const broken of [
      withoutHidden,
      { ...view, hiddenOrgIds: [1] },
      { ...view, showKeyPositions: 'yes' },
      { ...view, showPositionsWithoutSuccessor: undefined },
      { ...view, rootOrgId: 7 },
      { ...view, depth: 9 },
      { ...view, revision: -1 },
    ])
      expect(() => preferenceReceipt(broken)).toThrow();
  });
  it('偏好重读带回全量（含抽屉外的隐藏组织与只看关键岗位），提交时未改项取这份最新值', () => {
    expect(preferenceLatest(view).values).toEqual({
      rootOrgId: undefined,
      depth: 3,
      hiddenOrgIds: ['org-9'],
      showKeyPositions: true,
      showPositionsWithoutSuccessor: true,
    });
  });
  it('等级规则显示可选条件与值（eq + 指定人员），健康度还显示字段来源与自定义人员范围', () => {
    const lines = ruleLines(
      {
        expression: '1 and 2',
        rows: [
          {
            rowNo: 1,
            subject: 'incumbent',
            fieldCode: 'employee_id',
            filterOperator: 'eq',
            filterValues: ['合成甲', '合成乙'],
            measure: 'count',
            comparator: 'ge',
            threshold: 1,
          },
          {
            rowNo: 2,
            population: 'custom',
            populationId: 'pop-1',
            fieldSource: 'review',
            fieldCode: 'calibrated_perf',
            filterOperator: 'not_empty',
            filterValues: [],
            measure: 'review_result_ratio',
            comparator: 'ge',
            threshold: 20,
            isPercent: true,
          },
        ],
      },
      { 'pop-1': '合成青年人才' },
    );
    expect(lines?.rows).toEqual([
      '1. 现任人员 employee_id 等于 合成甲、合成乙 的 人数 大于等于 1',
      '2. 自定义人员范围「合成青年人才」 盘点字段 calibrated_perf 不为空 的 盘点结果占比 大于等于 20%',
    ]);
  });
  it('自定义人员范围查不到名称时显示编号，不留空', () => {
    const lines = ruleLines({
      expression: '1',
      rows: [
        { rowNo: 1, population: 'custom', populationId: 'pop-x', measure: 'count', comparator: 'gt', threshold: 0 },
      ],
    });
    expect(lines?.rows).toEqual(['1. 自定义人员范围（编号 pop-x） 人数 大于 0']);
  });
});

describe('AC-FE-R3d1 菜单下一层只列有入口对象的设置页', () => {
  const snapshot = (succession: string[], review: string[]) =>
    ({
      apps: [
        { app: 'succession', visible: true, entryObjects: succession },
        { app: 'talent-review', visible: true, entryObjects: review },
      ],
    }) as unknown as ServerSnapshot;
  it('健康度规则设置是独立页：健康度或人员范围对象可见时出现', () => {
    expect(settingsMenu(snapshot(['Succession.Population'], [])).map((node) => node.path)).toContain(
      '/succession/settings/health',
    );
    expect(settingsMenu(snapshot(['Succession.HealthLevel'], [])).map((node) => node.path)).not.toContain(
      '/succession/settings/map',
    );
  });
  it('等级对象不可见时不出现继任地图设置；准备度看人才盘点的准备度对象', () => {
    expect(settingsMenu(snapshot(['Succession.Map'], [])).map((node) => node.path)).toEqual([
      '/succession/manage',
      '/succession/settings/key-positions',
    ]);
    expect(
      settingsMenu(snapshot(['Succession.Map', 'Succession.RiskLevel'], ['TalentReview.Readiness'])).map(
        (node) => node.path,
      ),
    ).toEqual([
      '/succession/manage',
      '/succession/settings/map',
      '/succession/settings/key-positions',
      '/succession/settings/readiness',
    ]);
  });
});
