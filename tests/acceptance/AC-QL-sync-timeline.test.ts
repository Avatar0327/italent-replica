/**
 * AC-QL-sync 时间轴（R3-T02 C1-4 第 2 轮；用户 10-10 决定：口径 3 = A 统一时间轴、口径 6 = A 不补回；设计 §4.3、DEC-335①）：
 * - 新同步行生成时，把此前仍开放的最近一行（自动 / 手工混排）的 endDate 收到新行开始日前一天；同步行的 endDate 收到下一条的前一天；
 *   收尾只改 endDate，不改该行的来源，有版本和审计；
 * - 同一天的多笔事件按任职事件登记先后定序，不按消费 / 重试时刻：晚登记的赢，早登记的被取代（不生成或软删），
 *   所以“早一条失败重试在后一条之后成功”不会让当前资格倒退（P2-01）；
 * - HR 删除（或编辑）同步生成的行后，同一任职记录不再自动补回：判重看不可变的同步足迹（子集版本表），不看当前行的来源（P3-01）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { currentQualification } from '../../apps/api/src/modules/qualification/current.js';
import { qualificationSyncProbe } from '../../apps/api/src/modules/qualification/sync-worker.js';
import { syncWorld } from './AC-QL-sync-support.js';

const database = useTestDb();
const AT = '2026-10-10T05:00:00Z';

async function scene(label: string) {
  const w = await syncWorld(database().db, label);
  const jobLevelId = await w.jobLevel();
  const levelId = await w.level({ type: 'level', jobObjectId: jobLevelId });
  const sequences = [await w.sequence('序列一'), await w.sequence('序列二')];
  const categories = [
    await w.category({ type: 'sequence', jobObjectId: sequences[0]! }),
    await w.category({ type: 'sequence', jobObjectId: sequences[1]! }),
  ];
  await w.settleBaseline();
  await w.enableSync(true);
  const fields = (n: 0 | 1) => ({ sequenceId: sequences[n]!, levelId: jobLevelId });
  const current = () =>
    withTenant(w.db, w.tenantId, (tx) => currentQualification(tx, w.tenantId, w.subject.employee.id, '2026-10-10'));
  /** 登记先后用应用时钟区分：事件创建时间不同。 */
  const at = (iso: string) => w.session.setNow(iso);
  return { w, levelId, categories, fields, current, at };
}

const overlaps = (rows: { startDate: string; endDate: string | null }[]) =>
  rows.some((a, i) =>
    rows.some(
      (b, j) => i < j && a.startDate <= (b.endDate ?? '9999-12-31') && b.startDate <= (a.endDate ?? '9999-12-31'),
    ),
  );

describe('AC-QL-sync 同日事件按登记先后定序（P2-01，口径 3 = A）', () => {
  it('同日两笔：早登记的 A 失败、晚登记的 B 先成功，A 重试后当前资格仍是 B，时间轴不重叠（AC-QL-sync）', async () => {
    const { w, categories, fields, current, at } = await scene('qlsync-tl-reverse');
    at('2026-10-10T02:00:00Z');
    const a = await w.transferWith('2026-10-05', fields(0));
    at('2026-10-10T03:00:00Z');
    const b = await w.transferWith('2026-10-05', fields(1));
    let failA = true;
    qualificationSyncProbe.beforeWrite = async () => {
      if (failA) {
        failA = false;
        throw new Error('模拟 A 暂时失败');
      }
    };
    try {
      // 先到先处理：A 先取到并失败，B 随后成功
      expect(await w.run(AT)).toMatchObject({ failed: 1, done: 1 });
      expect((await current())?.categoryId).toBe(categories[1]);
      expect(await w.run('2026-10-10T07:00:00Z')).toMatchObject({ skipped: 1 });
    } finally {
      qualificationSyncProbe.beforeWrite = undefined;
    }
    expect(await w.queue(a)).toMatchObject([{ state: 'skipped', reason: 'SUPERSEDED_SAME_DAY', attempts: 2 }]);
    expect(await w.queue(b)).toMatchObject([{ state: 'done' }]);
    expect((await current())?.categoryId).toBe(categories[1]);
    const rows = await w.subsets();
    expect(rows).toHaveLength(1);
    expect(overlaps(rows)).toBe(false);
  });

  it('同日两笔按登记顺序完成：晚登记的取代早登记的（早的软删、留版本），当前资格是晚登记的（AC-QL-sync）', async () => {
    const { w, categories, fields, current, at } = await scene('qlsync-tl-forward');
    at('2026-10-10T02:00:00Z');
    const a = await w.transferWith('2026-10-05', fields(0));
    at('2026-10-10T03:00:00Z');
    const b = await w.transferWith('2026-10-05', fields(1));
    await w.run(AT);
    expect(await w.queue(a)).toMatchObject([{ state: 'done' }]);
    expect(await w.queue(b)).toMatchObject([{ state: 'done' }]);
    expect((await current())?.categoryId).toBe(categories[1]);
    const rows = await w.subsets();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employmentRecordId).toBe(b);
    const versions = await w.history();
    expect(versions.some((v) => v.employmentRecordId === a && v.deleted)).toBe(true);
  });
});

describe('AC-QL-sync 统一时间轴：收尾上一条（口径 3 = A，DEC-335①）', () => {
  it('新同步行收尾此前仍开放的最近一行：endDate 止于新开始日前一天，来源不变，留版本（AC-QL-sync）', async () => {
    const { w, fields } = await scene('qlsync-tl-close');
    const first = await w.transferWith('2026-10-01', fields(0));
    await w.run(AT);
    const second = await w.transferWith('2026-10-05', fields(1));
    await w.run('2026-10-10T06:00:00Z');
    const rows = await w.subsets();
    expect(rows).toMatchObject([
      { employmentRecordId: first, startDate: '2026-10-01', endDate: '2026-10-04', sourceType: 'employment_sync' },
      { employmentRecordId: second, startDate: '2026-10-05', endDate: null, sourceType: 'employment_sync' },
    ]);
    expect(rows[0]!.isAutoSync).toBe(true);
    expect((await w.history()).filter((v) => v.employmentRecordId === first)).toHaveLength(2);
  });

  it('乱序完成：晚日期的先同步，早日期的后同步时 endDate 收到下一条前一天（AC-QL-sync）', async () => {
    const { w, fields, current } = await scene('qlsync-tl-out-of-order');
    const early = await w.transferWith('2026-10-01', fields(0));
    const late = await w.transferWith('2026-10-05', fields(1));
    let failEarly = true;
    qualificationSyncProbe.beforeWrite = async () => {
      if (failEarly) {
        failEarly = false;
        throw new Error('模拟早日期暂时失败');
      }
    };
    try {
      await w.run(AT);
      await w.run('2026-10-10T07:00:00Z');
    } finally {
      qualificationSyncProbe.beforeWrite = undefined;
    }
    const rows = await w.subsets();
    expect(rows).toMatchObject([
      { employmentRecordId: early, startDate: '2026-10-01', endDate: '2026-10-04' },
      { employmentRecordId: late, startDate: '2026-10-05', endDate: null },
    ]);
    expect(overlaps(rows)).toBe(false);
    expect((await current())?.recordId).toBe(rows[1]!.id);
  });

  it('此前开放的是 HR 手工行：同样收尾，来源仍是 HR 手工（自动与手工混排，AC-QL-sync）', async () => {
    const { w, levelId, categories, fields } = await scene('qlsync-tl-manual');
    const manual = await w.api.request(
      'POST',
      `/api/tenant/personnel/employees/${w.subject.employee.id}/subsets/qualification`,
      {
        ...w.as,
        ifMatch: 0,
        body: { categoryId: categories[0], levelId, startDate: '2026-09-01' },
      },
    );
    expect(manual.status, await manual.clone().text()).toBe(201);
    const record = await w.transferWith('2026-10-05', fields(1));
    await w.run(AT);
    const rows = await w.subsets();
    expect(rows).toMatchObject([
      { startDate: '2026-09-01', endDate: '2026-10-04', sourceType: 'hr_direct', isAutoSync: false },
      { startDate: '2026-10-05', endDate: null, employmentRecordId: record },
    ]);
  });
});

describe('AC-QL-sync HR 删除 / 编辑后不补回（口径 6 = A，P3-01）', () => {
  it('HR 编辑后再删除同步行：同一任职记录再次触发同步不补回，足迹看子集版本而不是当前来源（AC-QL-sync）', async () => {
    const { w, fields } = await scene('qlsync-tl-footprint');
    const record = await w.transferWith('2026-10-05', fields(0));
    await w.run(AT);
    const [row] = await w.subsets();
    const path = `/api/tenant/personnel/employees/${w.subject.employee.id}/subsets/qualification/${row!.id}`;
    const edited = await w.api.request('PATCH', path, { ...w.as, ifMatch: 1, body: { endDate: '2026-12-31' } });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await w.subsets())[0]!.sourceType).not.toBe('employment_sync'); // 编辑改写了当前来源
    const removed = await w.api.request('DELETE', path, { ...w.as, ifMatch: 2 });
    expect(removed.status, await removed.clone().text()).toBe(200);

    await w.requeue(record);
    await w.run('2026-10-10T06:00:00Z');
    expect(await w.subsets()).toEqual([]);
    expect((await w.queue(record)).map((r) => r.state).sort()).toEqual(['done', 'done']);
  });
});
