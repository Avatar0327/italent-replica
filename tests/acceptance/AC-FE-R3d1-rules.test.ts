/**
 * FE-R3d-1 继任管理页面的纯规则（docs/02_业务建模/27 §1.1、§5.5、§5.6；Q-M0-178）。
 * 页面渲染由冒烟覆盖；这里锁定校验、请求体组装、菜单与地图结构这些逻辑。
 */
import { describe, expect, it } from 'vitest';
import type { ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import {
  assignBody,
  createRecordBody,
  endCommand,
  mapForest,
  recordDateErrors,
  recordQuery,
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
});

describe('AC-FE-R3d1 菜单下一层只列有入口对象的设置页', () => {
  const snapshot = (succession: string[], review: string[]) =>
    ({
      apps: [
        { app: 'succession', visible: true, entryObjects: succession },
        { app: 'talent-review', visible: true, entryObjects: review },
      ],
    }) as unknown as ServerSnapshot;
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
