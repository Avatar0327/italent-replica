/**
 * AC-DM-27（纯函数部分）：O（在职占用）/ P（编制占用）两个投影与操作前后差集
 * （docs/08_设计/R2-T03_离职管理设计.md §6B.1 / §6B.3，DEC-275②、DEC-496⑤）。
 * 区间一律半开 [from, to)，to = null 表示开放。
 */
import { describe, expect, it } from 'vitest';
import {
  exitOccupancy,
  newlyOccupied,
  type ExitOccupancyInput,
  type ExitState,
  type OccupancySegment,
  type PreOccupancySegment,
  type TimelineSegment,
} from './exit-occupancy.js';

const X = 'emp-x';
const S1 = 'staff-1';
const S2 = 'staff-2';

function record(
  recordId: string,
  departmentId: string,
  from: string,
  to: string | null,
  extra: Partial<TimelineSegment> = {},
): TimelineSegment {
  return {
    recordId,
    employeeId: X,
    staffId: S1,
    kind: 'transfer',
    departmentId,
    positionId: `pos-${departmentId}`,
    capacityId: null,
    from,
    to,
    ...extra,
  };
}

function application(
  businessId: string,
  departmentId: string,
  from: string,
  to: string | null,
  extra: Partial<PreOccupancySegment> = {},
): PreOccupancySegment {
  return {
    businessId,
    employeeId: X,
    staffId: S1,
    stage: 'in_review',
    departmentId,
    positionId: `pos-${departmentId}`,
    capacityId: null,
    from,
    to,
    plannedDate: from,
    operationKey: 1,
    ...extra,
  };
}

function exit(state: ExitState['state'], extra: Partial<ExitState> = {}): ExitState {
  return {
    businessId: 'exit-1',
    employeeId: X,
    staffId: S1,
    state,
    effectiveDate: '2026-10-21',
    releaseDate: '2026-10-06',
    nextCycleEntryDate: null,
    ...extra,
  };
}

const empty: ExitOccupancyInput = {
  records: [],
  applications: [],
  exits: [],
  detachedTransfers: [],
  timings: { transferIn: 'submitted', transferOut: 'submitted' },
};

/** 把结果压成 “部门 区间” 便于断言；同源多段按起点排序。 */
function view(segments: readonly OccupancySegment[]): string[] {
  return segments.map((s) => `${s.departmentId} [${s.from}, ${s.to ?? '∞'})`);
}

describe('exitOccupancy：O 投影（在职占用，§6A.1）', () => {
  const records = [record('rec-a', 'A', '2026-09-01', null, { kind: 'hire' })];

  it('approved 离职：同周期记录从 E 起不计（D ≥ E 不计，D < E 照常计入）', () => {
    const { o } = exitOccupancy({ ...empty, records, exits: [exit('approved')] });
    expect(view(o)).toEqual(['A [2026-09-01, 2026-10-21)']);
  });

  it.each(['draft', 'in_review', 'rejected', 'disapproved', 'voided', 'deleted'] as const)(
    '%s 离职不影响 O 与 P（离职未定或已作废）',
    (state) => {
      const result = exitOccupancy({ ...empty, records, exits: [exit(state)] });
      expect(view(result.o)).toEqual(['A [2026-09-01, ∞)']);
      expect(view(result.p)).toEqual(['A [2026-09-01, ∞)']);
    },
  );

  it('effective 离职：时间轴已截断到 L′，O 不再扣（不重复扣），离职记录本身不占用', () => {
    const { o } = exitOccupancy({
      ...empty,
      records: [
        record('rec-a', 'A', '2026-09-01', '2026-10-21', { kind: 'hire' }),
        record('rec-leave', 'A', '2026-10-21', null, { kind: 'leave' }),
      ],
      exits: [exit('effective')],
    });
    expect(view(o)).toEqual(['A [2026-09-01, 2026-10-21)']);
  });

  it('retirement 记录同样不占用', () => {
    const { o, p } = exitOccupancy({
      ...empty,
      records: [record('rec-r', 'A', '2026-09-01', null, { kind: 'retirement' })],
    });
    expect(o).toEqual([]);
    expect(p).toEqual([]);
  });

  it('staff_id 不跨周期：旧周期 approved 离职不影响新周期（重聘）记录', () => {
    const { o, p } = exitOccupancy({
      ...empty,
      records: [
        record('rec-a', 'A', '2026-09-01', '2026-10-10', { kind: 'hire' }),
        record('rec-new', 'A', '2026-11-01', null, { kind: 'rehire', staffId: S2 }),
      ],
      exits: [
        exit('approved', { effectiveDate: '2026-10-05', releaseDate: '2026-10-01', nextCycleEntryDate: '2026-11-01' }),
      ],
    });
    expect(view(o)).toEqual(['A [2026-09-01, 2026-10-05)', 'A [2026-11-01, ∞)']);
    expect(view(p)).toEqual(['A [2026-09-01, 2026-10-01)', 'A [2026-11-01, ∞)']);
  });

  it('同员工同组织两条记录（组织调整前后）按条计：每条各自一段，不合并', () => {
    const { o } = exitOccupancy({
      ...empty,
      records: [
        record('rec-1', 'A', '2026-09-01', '2026-10-10', { kind: 'hire' }),
        record('rec-2', 'A', '2026-10-10', null, { kind: 'org_adjustment' }),
      ],
      exits: [exit('approved', { effectiveDate: '2026-10-21' })],
    });
    expect(o.map((s) => s.sourceId)).toEqual(['rec-1', 'rec-2']);
    expect(view(o)).toEqual(['A [2026-09-01, 2026-10-10)', 'A [2026-10-10, 2026-10-21)']);
  });

  it('离职日期早于记录起点时，整条记录不计（空段丢弃）', () => {
    const { o } = exitOccupancy({
      ...empty,
      records: [record('rec-t', 'B', '2026-10-25', null)],
      exits: [exit('approved', { effectiveDate: '2026-10-21' })],
    });
    expect(o).toEqual([]);
  });

  it('同日多条记录、不同员工互不影响', () => {
    const other = record('rec-y', 'A', '2026-09-01', null, { employeeId: 'emp-y', staffId: 'staff-y' });
    const { o } = exitOccupancy({ ...empty, records: [...records, other], exits: [exit('approved')] });
    expect(o.map((s) => `${s.employeeId}:${s.sourceId}:${s.to ?? '∞'}`)).toEqual([
      'emp-x:rec-a:2026-10-21',
      'emp-y:rec-y:∞',
    ]);
  });
});

describe('exitOccupancy：P 投影（编制占用，§6B.1 / §6）', () => {
  const records = [record('rec-a', 'A', '2026-09-01', null, { kind: 'hire' })];

  it('approved / effective 离职：同周期记录在 [R, 下一周期入职日) 不计，不用 L 过滤', () => {
    for (const state of ['approved', 'effective'] as const) {
      const { p } = exitOccupancy({ ...empty, records, exits: [exit(state)] });
      expect(view(p), state).toEqual(['A [2026-09-01, 2026-10-06)']);
    }
  });

  it('R 之后才开始的同周期记录同样不计（B-62b：审批中途生成的组织调整）', () => {
    const { p } = exitOccupancy({
      ...empty,
      records: [
        record('rec-a', 'A', '2026-09-01', '2026-10-10', { kind: 'hire' }),
        record('rec-adj', 'A2', '2026-10-10', null, { kind: 'org_adjustment' }),
      ],
      exits: [exit('approved')],
    });
    expect(view(p)).toEqual(['A [2026-09-01, 2026-10-06)']);
  });

  describe('申请预占段与控编时机（main projectedMembers 口径）', () => {
    const app = application('app-t', 'B', '2026-10-25', null);

    it('transferIn = transferOut = submitted：审批中申请已在目标占编，并从原岗位提前扣出', () => {
      const { p } = exitOccupancy({ ...empty, records, applications: [app] });
      expect(view(p)).toEqual(['A [2026-09-01, 2026-10-25)', 'B [2026-10-25, ∞)']);
    });

    it('transferIn = transferOut = approved：审批中申请不预占也不扣出；批准后才计入', () => {
      const timings = { transferIn: 'approved', transferOut: 'approved' } as const;
      expect(view(exitOccupancy({ ...empty, records, applications: [app], timings }).p)).toEqual(['A [2026-09-01, ∞)']);
      const approved = { ...app, stage: 'approved' } as const;
      expect(view(exitOccupancy({ ...empty, records, applications: [approved], timings }).p)).toEqual([
        'A [2026-09-01, 2026-10-25)',
        'B [2026-10-25, ∞)',
      ]);
    });

    it('两个时机可以不同：transferIn = submitted、transferOut = approved', () => {
      const timings = { transferIn: 'submitted', transferOut: 'approved' } as const;
      expect(view(exitOccupancy({ ...empty, records, applications: [app], timings }).p)).toEqual([
        'A [2026-09-01, ∞)',
        'B [2026-10-25, ∞)',
      ]);
    });

    it('申请的终点（插入窗口结束）截断预占段与扣出段', () => {
      const bounded = application('app-t', 'B', '2026-10-25', '2026-11-05');
      expect(view(exitOccupancy({ ...empty, records, applications: [bounded] }).p)).toEqual([
        'A [2026-09-01, 2026-10-25)',
        'A [2026-11-05, ∞)',
        'B [2026-10-25, 2026-11-05)',
      ]);
    });

    it('离职预减同时扣掉申请预占段：预占起点 ≥ R 的整段不占编（§6-4）', () => {
      const { p } = exitOccupancy({ ...empty, records, applications: [app], exits: [exit('approved')] });
      expect(view(p)).toEqual(['A [2026-09-01, 2026-10-06)']);
    });

    it('预占起点 < R 的申请在目标岗位占编到 R', () => {
      const early = application('app-t', 'B', '2026-10-02', null);
      const { p } = exitOccupancy({ ...empty, records, applications: [early], exits: [exit('approved')] });
      expect(view(p)).toEqual(['A [2026-09-01, 2026-10-02)', 'B [2026-10-02, 2026-10-06)']);
    });

    it('申请的 selectedStaffId 与离职周期不同时不受预减影响', () => {
      const { p } = exitOccupancy({
        ...empty,
        records,
        applications: [application('app-new', 'B', '2026-11-01', null, { staffId: S2 })],
        exits: [exit('approved', { nextCycleEntryDate: null })],
      });
      expect(view(p)).toEqual(['A [2026-09-01, 2026-10-06)', 'B [2026-11-01, ∞)']);
    });

    it('已落地待复查的调动（stage = effective）与已批准同口径；O 不读申请', () => {
      const landed = application('app-t', 'B', '2026-10-25', null, { stage: 'effective' });
      const result = exitOccupancy({
        ...empty,
        records,
        applications: [landed],
        timings: { transferIn: 'approved', transferOut: 'approved' },
      });
      expect(view(result.p)).toEqual(['A [2026-09-01, 2026-10-25)', 'B [2026-10-25, ∞)']);
      expect(view(result.o)).toEqual(['A [2026-09-01, ∞)']);
    });
  });

  it('approved / effective 离职缺少释放时点 R：输入错误，抛 RangeError 而不是静默放行', () => {
    expect(() => exitOccupancy({ ...empty, records, exits: [exit('approved', { releaseDate: null })] })).toThrow(
      RangeError,
    );
    expect(() => exitOccupancy({ ...empty, records, exits: [exit('effective', { releaseDate: null })] })).toThrow(
      RangeError,
    );
    expect(() => exitOccupancy({ ...empty, records, exits: [exit('in_review', { releaseDate: null })] })).not.toThrow();
  });

  it('区间倒置的输入直接拒绝', () => {
    expect(() => exitOccupancy({ ...empty, records: [record('r', 'A', '2026-10-02', '2026-10-01')] })).toThrow(
      RangeError,
    );
  });
});

describe('P 投影：多笔申请按 main 的逐笔顺序累计（projectedMembers）', () => {
  const records = [record('rec-a', 'A', '2026-09-01', null, { kind: 'hire' })];
  const submitted = { transferIn: 'submitted', transferOut: 'submitted' } as const;
  const approvedOnly = { transferIn: 'approved', transferOut: 'approved' } as const;
  const t1 = application('app-1', 'B', '2026-10-25', null);
  const t2 = application('app-2', 'C', '2026-11-01', null, { operationKey: 2 });
  const p = (input: Partial<ExitOccupancyInput>) => view(exitOccupancy({ ...empty, records, ...input }).p);

  it('不同日期：后序申请扣掉此前累计的预占（T1 10-25 调入 B、T2 11-01 调入 C → B 只到 11-01）', () => {
    const expected = ['A [2026-09-01, 2026-10-25)', 'B [2026-10-25, 2026-11-01)', 'C [2026-11-01, ∞)'];
    expect(p({ applications: [t1, t2] })).toEqual(expected);
    expect(p({ applications: [t2, t1] })).toEqual(expected);
  });

  it('不同日期：撤销 approved 离职后的 ΔP 里 B 是 [10-25, 11-01)，不是 [10-25, ∞)', () => {
    const applications = [t1, t2];
    const result = exitOccupancy({ ...empty, records, applications, exits: [exit('approved')] });
    const after = exitOccupancy({ ...empty, records, applications });
    expect(view(newlyOccupied(result.p, after.p))).toEqual([
      'A [2026-10-06, 2026-10-25)',
      'B [2026-10-25, 2026-11-01)',
      'C [2026-11-01, ∞)',
    ]);
  });

  describe('同日：先后由计划日、再由操作序号决定，与数组顺序、业务 ID 大小无关', () => {
    const sameDay = (id1: string, id2: string, extra1 = {}, extra2 = {}) => [
      application(id1, 'B', '2026-10-25', null, { operationKey: 1, ...extra1 }),
      application(id2, 'C', '2026-10-25', null, { operationKey: 2, ...extra2 }),
    ];

    it.each([
      ['业务 ID 与操作序号同序', 'app-a', 'app-z'],
      ['业务 ID 与操作序号反序（UUID 不能决定先后）', 'app-z', 'app-a'],
    ])('操作序号小的先处理，后者扣掉前者：%s', (_name, id1, id2) => {
      const applications = sameDay(id1, id2);
      const expected = ['A [2026-09-01, 2026-10-25)', 'C [2026-10-25, ∞)'];
      expect(p({ applications })).toEqual(expected);
      expect(p({ applications: [...applications].reverse() })).toEqual(expected);
    });

    it('计划日更早的先处理，哪怕操作序号更大', () => {
      const applications = sameDay(
        'app-1',
        'app-2',
        { plannedDate: '2026-10-20', operationKey: 9 },
        { plannedDate: '2026-10-22' },
      );
      // app-1 计划日 10-20 先处理；app-2（C）后处理并扣掉 B
      expect(p({ applications })).toEqual(['A [2026-09-01, 2026-10-25)', 'C [2026-10-25, ∞)']);
      const reversed = sameDay(
        'app-1',
        'app-2',
        { plannedDate: '2026-10-22', operationKey: 1 },
        { plannedDate: '2026-10-20', operationKey: 2 },
      );
      // app-2（C）计划日更早先处理，app-1（B）后处理并扣掉 C
      expect(p({ applications: reversed })).toEqual(['A [2026-09-01, 2026-10-25)', 'B [2026-10-25, ∞)']);
    });

    it('没有操作序号（正在落地的直接业务）视为最新，排最后', () => {
      const applications = sameDay('app-1', 'app-2', { operationKey: null }, { operationKey: 5 });
      expect(p({ applications })).toEqual(['A [2026-09-01, 2026-10-25)', 'B [2026-10-25, ∞)']);
    });
  });

  describe('控编时机组合', () => {
    it('transferIn = transferOut = approved：只有已批准的申请计入；审批中的既不预占也不扣出', () => {
      const approved1 = { ...t1, stage: 'approved' } as const;
      expect(p({ applications: [approved1, t2], timings: approvedOnly })).toEqual([
        'A [2026-09-01, 2026-10-25)',
        'B [2026-10-25, ∞)',
      ]);
      const approved2 = { ...t2, stage: 'approved' } as const;
      expect(p({ applications: [t1, approved2], timings: approvedOnly })).toEqual([
        'A [2026-09-01, 2026-11-01)',
        'C [2026-11-01, ∞)',
      ]);
    });

    it('transferIn = submitted、transferOut = approved：审批中的申请只预占不扣出，两笔都预占、原岗位不被扣', () => {
      expect(p({ applications: [t1, t2], timings: { transferIn: 'submitted', transferOut: 'approved' } })).toEqual([
        'A [2026-09-01, ∞)',
        'B [2026-10-25, ∞)',
        'C [2026-11-01, ∞)',
      ]);
    });

    it('transferIn = approved、transferOut = submitted：审批中的申请只扣出不预占，后序申请照样扣掉此前累计的预占', () => {
      const approved1 = { ...t1, stage: 'approved' } as const;
      // T1 已批准：扣出 A、预占 B；T2 审批中：只扣出（扣掉 A 与 B 在 11-01 之后的部分），不预占 C
      expect(
        p({ applications: [approved1, t2], timings: { transferIn: 'approved', transferOut: 'submitted' } }),
      ).toEqual(['A [2026-09-01, 2026-10-25)', 'B [2026-10-25, 2026-11-01)']);
    });
  });

  it('离职预减在逐笔累计之后统一扣：R 之后的预占与累计结果都不计', () => {
    expect(p({ applications: [t1, t2], exits: [exit('approved', { releaseDate: '2026-10-28' })] })).toEqual([
      'A [2026-09-01, 2026-10-25)',
      'B [2026-10-25, 2026-10-28)',
    ]);
  });
});

describe('newlyOccupied：操作前后差集，§6B.3 逐行', () => {
  const aRecord = (to: string | null) => record('rec-a', 'A', '2026-09-01', to, { kind: 'hire' });
  const future = record('rec-t', 'B', '2026-10-25', null);
  const delta = (before: ExitOccupancyInput, after: ExitOccupancyInput) => {
    const b = exitOccupancy(before);
    const a = exitOccupancy(after);
    return { o: view(newlyOccupied(b.o, a.o)), p: view(newlyOccupied(b.p, a.p)) };
  };

  it('#1 撤销 approved 离职（B-63）：ΔO 含 E 之后已落地的未来直接调动 T 在 B 的 [10-25, ∞)', () => {
    const records = [aRecord('2026-10-25'), future];
    const result = delta({ ...empty, records, exits: [exit('approved')] }, { ...empty, records, exits: [] });
    expect(result.o).toEqual(['A [2026-10-21, 2026-10-25)', 'B [2026-10-25, ∞)']);
    expect(result.p).toEqual(['A [2026-10-06, 2026-10-25)', 'B [2026-10-25, ∞)']);
  });

  it('#1 B-63d：E 之后另有同周期组织调整记录，ΔO 含该记录整段', () => {
    const records = [
      aRecord('2026-10-23'),
      record('rec-adj', 'A2', '2026-10-23', '2026-10-31', { kind: 'org_adjustment' }),
      record('rec-end', 'A3', '2026-10-31', null, { kind: 'transfer' }),
    ];
    const result = delta({ ...empty, records, exits: [exit('approved')] }, { ...empty, records, exits: [] });
    expect(result.o).toEqual(['A [2026-10-21, 2026-10-23)', 'A2 [2026-10-23, 2026-10-31)', 'A3 [2026-10-31, ∞)']);
  });

  it('#1 B-77：撤销 approved 离职，审批中的调入申请预占段 [10-25, ∞) 与原岗位 [10-06, 10-25) 都在 ΔP', () => {
    const records = [aRecord(null)];
    const applications = [application('app-t', 'B', '2026-10-25', null)];
    const result = delta(
      { ...empty, records, applications, exits: [exit('approved')] },
      { ...empty, records, applications, exits: [] },
    );
    expect(result.p).toEqual(['A [2026-10-06, 2026-10-25)', 'B [2026-10-25, ∞)']);
  });

  it('#1 B-77：控编时机 = approved 时，审批中的申请既不预占也不扣出，ΔP 只有原岗位 [10-06, ∞)', () => {
    const records = [aRecord(null)];
    const applications = [application('app-t', 'B', '2026-10-25', null)];
    const timings = { transferIn: 'approved', transferOut: 'approved' } as const;
    const result = delta(
      { ...empty, records, applications, timings, exits: [exit('approved')] },
      { ...empty, records, applications, timings, exits: [] },
    );
    expect(result.p).toEqual(['A [2026-10-06, ∞)']);
  });

  it('#2 撤销已生效离职：前一条恢复到最终窗口，被摘下的 T 挂回；被作废的申请没有预占段（B-77a）', () => {
    const detached = { segment: future, detachedBy: 'exit-1' };
    const before: ExitOccupancyInput = {
      ...empty,
      records: [aRecord('2026-10-21'), record('rec-leave', 'A', '2026-10-21', null, { kind: 'leave' })],
      detachedTransfers: [detached],
      exits: [exit('effective')],
    };
    const after: ExitOccupancyInput = {
      ...empty,
      records: [aRecord('2026-10-25')],
      detachedTransfers: [detached],
      exits: [],
    };
    expect(exitOccupancy(before).o.some((s) => s.departmentId === 'B')).toBe(false);
    const result = delta(before, after);
    expect(result.o).toEqual(['A [2026-10-21, 2026-10-25)', 'B [2026-10-25, ∞)']);
    expect(result.p).toEqual(['A [2026-10-06, 2026-10-25)', 'B [2026-10-25, ∞)']);
  });

  it('#2 被摘下的 T 只在摘下它的离职不再生效时才计：离职仍 effective 则不计', () => {
    const detached = { segment: future, detachedBy: 'exit-1' };
    const withExit = exitOccupancy({
      ...empty,
      records: [aRecord('2026-10-21')],
      detachedTransfers: [detached],
      exits: [exit('effective')],
    });
    expect(withExit.p.map((s) => s.sourceId)).not.toContain('rec-t');
    const without = exitOccupancy({
      ...empty,
      records: [aRecord('2026-10-25')],
      detachedTransfers: [detached],
      exits: [],
    });
    expect(without.p.map((s) => s.sourceId)).toContain('rec-t');
  });

  it('#3 迟到简单顺延 E → E′：ΔO = [E, E′)，ΔP 为空（R 不变）', () => {
    const before: ExitOccupancyInput = {
      ...empty,
      records: [aRecord(null)],
      exits: [exit('approved', { effectiveDate: '2026-10-16' })],
    };
    const after: ExitOccupancyInput = {
      ...empty,
      records: [aRecord('2026-10-20'), record('rec-leave', 'A', '2026-10-20', null, { kind: 'leave' })],
      exits: [exit('effective', { effectiveDate: '2026-10-20' })],
    };
    const result = delta(before, after);
    expect(result.o).toEqual(['A [2026-10-16, 2026-10-20)']);
    expect(result.p).toEqual([]);
  });

  it('#4 / #5 区间非空 REBUILD_REQUIRED 与正常生效（a = E）：O、P 均不变', () => {
    const before: ExitOccupancyInput = { ...empty, records: [aRecord(null)], exits: [exit('approved')] };
    const after: ExitOccupancyInput = {
      ...empty,
      records: [aRecord('2026-10-21'), record('rec-leave', 'A', '2026-10-21', null, { kind: 'leave' })],
      exits: [exit('effective')],
    };
    expect(delta(before, before)).toEqual({ o: [], p: [] });
    expect(delta(before, after)).toEqual({ o: [], p: [] });
  });

  it('#6 离职落地（approved → effective）时作废在途申请：截断后的时间轴、申请消失，ΔO、ΔP 均为空', () => {
    const before: ExitOccupancyInput = {
      ...empty,
      records: [aRecord(null)],
      applications: [application('app-t', 'B', '2026-10-25', null, { stage: 'approved' })],
      exits: [exit('approved')],
    };
    const after: ExitOccupancyInput = {
      ...empty,
      records: [aRecord('2026-10-21'), record('rec-leave', 'A', '2026-10-21', null, { kind: 'leave' })],
      applications: [],
      exits: [exit('effective')],
    };
    expect(view(exitOccupancy(before).p)).toEqual(['A [2026-09-01, 2026-10-06)']);
    expect(delta(before, after)).toEqual({ o: [], p: [] });
  });

  it('#8 审批中离职照常计入：作为停用计数的基线，排定 / 作废离职前后都不变', () => {
    const records = [aRecord(null)];
    expect(
      delta({ ...empty, records, exits: [exit('in_review')] }, { ...empty, records, exits: [exit('voided')] }),
    ).toEqual({
      o: [],
      p: [],
    });
  });

  it('差集按记录、部门、岗位逐段求差，部分重叠只留新增部分；staff_id 不同的段互不抵消', () => {
    const before: OccupancySegment[] = [
      {
        sourceId: 'r1',
        employeeId: X,
        staffId: S1,
        departmentId: 'A',
        positionId: 'p',
        capacityId: null,
        from: '2026-10-01',
        to: '2026-10-10',
      },
    ];
    const after: OccupancySegment[] = [
      {
        sourceId: 'r1',
        employeeId: X,
        staffId: S1,
        departmentId: 'A',
        positionId: 'p',
        capacityId: null,
        from: '2026-10-01',
        to: null,
      },
      {
        sourceId: 'r1',
        employeeId: X,
        staffId: S2,
        departmentId: 'A',
        positionId: 'p',
        capacityId: null,
        from: '2026-10-01',
        to: '2026-10-05',
      },
    ];
    expect(view(newlyOccupied(before, after))).toEqual(['A [2026-10-10, ∞)', 'A [2026-10-01, 2026-10-05)']);
    expect(newlyOccupied(after, after)).toEqual([]);
  });

  it('输出确定：同一输入顺序打乱后结果相同', () => {
    const rows = [
      record('rec-b', 'B', '2026-10-25', null),
      record('rec-a', 'A', '2026-09-01', '2026-10-25', { kind: 'hire' }),
    ];
    const a = exitOccupancy({ ...empty, records: rows, exits: [exit('approved')] });
    const b = exitOccupancy({ ...empty, records: [...rows].reverse(), exits: [exit('approved')] });
    expect(a).toEqual(b);
  });
});
