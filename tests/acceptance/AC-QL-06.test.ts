/**
 * AC-QL-06（R3-T02 C1-4，设计 §4.2 / §4.3；QL-R15、DEC-331④、DEC-335②）：任职生效同步到任职资格子集。
 * - SW73 开 → 子集 +1（来源 employment_sync、isAutoSync = true、带任职记录 ID）；关 → 队列行 skipped，不写子集；
 * - 唯一映射：类别按 职位 > 职务 > 职务序列 > 职级类别，第一个恰好命中 1 个启用类别的类型胜出（跨类型多命中只生成 1 条）；
 *   级别 = 职级 / 职等关联的启用级别，须恰好 1 个；不唯一 skipped: AMBIGUOUS_MAPPING，没有命中 skipped: NO_MAPPING；
 * - 只对入职 / 重聘 / 转正 / 调动类业务同步：离职、退休、组织调整 skipped: KIND_NOT_SYNCED（DEC-335② 🟡）。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { mapEmploymentToQualification } from '../../apps/api/src/modules/qualification/sync-mapping.js';
import { syncWorld } from './AC-QL-sync-support.js';

const database = useTestDb();
const TODAY = '2026-10-10';
const AT = '2026-10-10T05:00:00Z';

const ids = () => ({ position: randomUUID(), post: randomUUID(), sequence: randomUUID(), grade: randomUUID() });

async function mapping(w: Awaited<ReturnType<typeof syncWorld>>, fields: Record<string, string | null>) {
  return withTenant(w.db, w.tenantId, (tx) =>
    mapEmploymentToQualification(
      tx,
      w.tenantId,
      { positionId: null, postId: null, sequenceId: null, levelId: null, gradeId: null, ...fields },
      TODAY,
    ),
  );
}

describe('AC-QL-06 唯一映射（QL-R15、DEC-335②）', () => {
  it('类别按 职位 > 职务 > 职务序列 命中；跨类型多命中只取优先级最高的 1 个（AC-QL-06）', async () => {
    const w = await syncWorld(database().db, 'ql06-priority');
    const job = ids();
    const byPosition = await w.category({ type: 'position', jobObjectId: job.position });
    const byPost = await w.category({ type: 'post', jobObjectId: job.post });
    const bySequence = await w.category({ type: 'sequence', jobObjectId: job.sequence });
    const level = await w.level({ type: 'grade', jobObjectId: job.grade });
    const all = { positionId: job.position, postId: job.post, sequenceId: job.sequence, gradeId: job.grade };

    expect(await mapping(w, all)).toEqual({ kind: 'mapped', categoryId: byPosition, levelId: level });
    expect(await mapping(w, { ...all, positionId: null })).toEqual({
      kind: 'mapped',
      categoryId: byPost,
      levelId: level,
    });
    expect(await mapping(w, { ...all, positionId: null, postId: null })).toEqual({
      kind: 'mapped',
      categoryId: bySequence,
      levelId: level,
    });
  });

  it('停用的类别不算命中：该类型落空，继续看下一个类型（AC-QL-06）', async () => {
    const w = await syncWorld(database().db, 'ql06-disabled-category');
    const job = ids();
    await w.category({ type: 'position', jobObjectId: job.position }, { enabled: false });
    const bySequence = await w.category({ type: 'sequence', jobObjectId: job.sequence });
    const level = await w.level({ type: 'grade', jobObjectId: job.grade });
    expect(await mapping(w, { positionId: job.position, sequenceId: job.sequence, gradeId: job.grade })).toEqual({
      kind: 'mapped',
      categoryId: bySequence,
      levelId: level,
    });
  });

  it('没有任何类别命中 → NO_MAPPING；类别命中但没有启用级别 → NO_MAPPING（AC-QL-06）', async () => {
    const w = await syncWorld(database().db, 'ql06-no-mapping');
    const job = ids();
    expect(await mapping(w, { positionId: job.position, gradeId: job.grade })).toEqual({
      kind: 'skipped',
      reason: 'NO_MAPPING',
    });
    await w.category({ type: 'position', jobObjectId: job.position });
    await w.level({ type: 'grade', jobObjectId: job.grade }, { enabled: false });
    expect(await mapping(w, { positionId: job.position, gradeId: job.grade })).toEqual({
      kind: 'skipped',
      reason: 'NO_MAPPING',
    });
  });

  it('职级与职等分别指向两个不同级别 → AMBIGUOUS_MAPPING，不猜（AC-QL-06）', async () => {
    const w = await syncWorld(database().db, 'ql06-ambiguous-level');
    const job = ids();
    const levelJobId = randomUUID();
    await w.category({ type: 'position', jobObjectId: job.position });
    await w.level({ type: 'level', jobObjectId: levelJobId });
    await w.level({ type: 'grade', jobObjectId: job.grade });
    expect(await mapping(w, { positionId: job.position, levelId: levelJobId, gradeId: job.grade })).toEqual({
      kind: 'skipped',
      reason: 'AMBIGUOUS_MAPPING',
    });
  });

  it('只给职级（或只给职等）能唯一定位级别（AC-QL-06）', async () => {
    const w = await syncWorld(database().db, 'ql06-level-only');
    const job = ids();
    const levelJobId = randomUUID();
    const category = await w.category({ type: 'position', jobObjectId: job.position });
    const byLevel = await w.level({ type: 'level', jobObjectId: levelJobId });
    expect(await mapping(w, { positionId: job.position, levelId: levelJobId })).toEqual({
      kind: 'mapped',
      categoryId: category,
      levelId: byLevel,
    });
  });
});

describe('AC-QL-06 SW73 与任职事件（设计 §4.3）', () => {
  async function scene(label: string) {
    const w = await syncWorld(database().db, label);
    const sequenceId = await w.sequence('同步序列');
    const jobLevelId = await w.jobLevel();
    const categoryId = await w.category({ type: 'sequence', jobObjectId: sequenceId });
    const levelId = await w.level({ type: 'level', jobObjectId: jobLevelId });
    await w.settleBaseline();
    const fields = { sequenceId, levelId: jobLevelId };
    return { w, fields, categoryId, levelId };
  }

  it('SW73 开：生效的调动同步生成 1 条子集，来源 employment_sync、isAutoSync = true、带记录 ID，队列 done（AC-QL-06）', async () => {
    const { w, fields, categoryId, levelId } = await scene('ql06-on');
    await w.enableSync(true);
    const recordId = await w.transferWith('2026-10-05', fields);
    await w.run(AT);
    expect(await w.queue(recordId)).toMatchObject([{ state: 'done', reason: null, attempts: 1 }]);
    expect(await w.subsets()).toMatchObject([
      {
        categoryId,
        levelId,
        startDate: '2026-10-05',
        endDate: null,
        sourceType: 'employment_sync',
        sourceId: recordId,
        isAutoSync: true,
        employmentRecordId: recordId,
      },
    ]);
  });

  it('SW73 关（缺省）：队列行 skipped: SETTING_DISABLED，不写子集（AC-QL-06）', async () => {
    const { w, fields } = await scene('ql06-off');
    const recordId = await w.transferWith('2026-10-05', fields);
    await w.run(AT);
    expect(await w.queue(recordId)).toMatchObject([{ state: 'skipped', reason: 'SETTING_DISABLED' }]);
    expect(await w.subsets()).toEqual([]);
  });

  it('映射不唯一或没有命中：skipped 且不写子集（AC-QL-06）', async () => {
    const { w } = await scene('ql06-unmapped');
    await w.enableSync(true);
    const recordId = await w.transferWith('2026-10-05', { sequenceId: await w.sequence('没有关联类别的序列') });
    await w.run(AT);
    expect(await w.queue(recordId)).toMatchObject([{ state: 'skipped', reason: 'NO_MAPPING' }]);
    expect(await w.subsets()).toEqual([]);
  });

  it('离职不同步：kind = leave 的事件 skipped: KIND_NOT_SYNCED（DEC-335② 🟡，AC-QL-06）', async () => {
    const { w } = await scene('ql06-leave');
    await w.enableSync(true);
    const recordId = await w.leave('2026-10-04');
    await w.run(AT);
    expect(await w.queue(recordId)).toMatchObject([{ state: 'skipped', reason: 'KIND_NOT_SYNCED' }]);
    expect(await w.subsets()).toEqual([]);
  });

  it('再跑一轮：已处理的行不重复处理，子集不新增（AC-QL-06）', async () => {
    const { w, fields } = await scene('ql06-rerun');
    await w.enableSync(true);
    const recordId = await w.transferWith('2026-10-05', fields);
    await w.run(AT);
    const before = await w.queue(recordId);
    const again = await w.run('2026-10-10T06:00:00Z');
    expect(again).toMatchObject({ done: 0, skipped: 0, failed: 0 });
    expect(await w.queue(recordId)).toEqual(before);
    expect(await w.subsets()).toHaveLength(1);
  });
});
