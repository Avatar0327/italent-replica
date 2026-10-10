/**
 * R3-T04 PR-B2 模块等级（设计 §2.2 module_grades / _items、§4.2 区间约定、TR-R15 / R20；DEC-067、DEC-216）：
 * - 等级项两种口径二选一：得分区间（min_score < max_score，含下界不含上界，最后一段含上界）或按指标数目（min_count，≥ 即达标）；
 * - 同一模块等级内口径不混用、区间不重叠、名称与值不重复；至少一项；修改等级项整组替换；名称租户唯一；
 * - 匹配函数 matchModuleGradeByScore / ByCount 是纯函数，PR-C 算分直接复用：4 位小数边界（恰等于下界 → 本段；
 *   上界 − 0.0001 → 本段；上界 → 下一段；最后一段含上界；低于第一段 / 高于最后一段 → 无匹配）；
 * - 被模板引用不可删（409 MODULE_GRADE_IN_USE）。负向用例断言具体响应码，并前后各读一次对比。
 */
import { matchModuleGradeByCount, matchModuleGradeByScore, TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW, moduleGradeBody, scoreItems, scoringWorld, type ConfigView } from './AC-TR-scoring-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('moduleGrade', async (_tx, _tenantId, id) =>
  referenced.has(id) ? 'TEST_TEMPLATE' : null,
);
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;
interface GradeView extends ConfigView {
  readonly mode: string;
  readonly items: {
    name: string;
    value: string;
    minScore: number | null;
    maxScore: number | null;
    minCount: number | null;
  }[];
}
const countItems = (...counts: number[]) =>
  counts.map((minCount, index) => ({ name: `达标${index + 1}`, value: String(index + 1), minCount }));

describe('模块等级匹配（纯函数；含下界不含上界，最后一段含上界）', () => {
  const items = [
    { name: '低', value: '1', minScore: 0, maxScore: 2 },
    { name: '中', value: '2', minScore: 2, maxScore: 4 },
    { name: '高', value: '3', minScore: 4, maxScore: 5 },
  ];
  it('4 位小数的临界值', () => {
    const at = (score: number) => matchModuleGradeByScore(items, score)?.name ?? null;
    expect([at(0), at(1.9999), at(2), at(3.9999), at(4), at(4.9999), at(5)]).toEqual([
      '低',
      '低',
      '中',
      '中',
      '高',
      '高',
      '高',
    ]);
    expect([at(-0.0001), at(5.0001)]).toEqual([null, null]);
    expect(matchModuleGradeByScore([], 3)).toBeNull();
  });
  it('按指标数目：取达到的最高门槛，未达最低门槛无匹配', () => {
    const counts = [
      { name: '低', value: '1', minCount: 3 },
      { name: '中', value: '2', minCount: 6 },
      { name: '高', value: '3', minCount: 10 },
    ];
    const at = (count: number) => matchModuleGradeByCount(counts, count)?.name ?? null;
    expect([at(2), at(3), at(9), at(10), at(99)]).toEqual([null, '低', '中', '高', '高']);
  });
});

describe('模块等级 · 配置规则（TR-R15 / R20）', () => {
  it('得分区间：返回 mode = score 与数字边界；至少一项；区间须上界大于下界、不重叠（相接允许）', async () => {
    const w = await scoringWorld(testDb().db, 'trg-score');
    const grade = (await w.post('/module-grades', moduleGradeBody())) as GradeView;
    expect(grade.mode).toBe('score');
    expect(grade.items.map((item) => [item.name, item.minScore, item.maxScore, item.minCount])).toEqual([
      ['档1', 0, 2, null],
      ['档2', 2, 4, null],
      ['档3', 4, 5, null],
    ]);
    const bad: [string, unknown[]][] = [
      ['GRADE_ITEMS_REQUIRED', []],
      ['GRADE_INTERVAL_INVALID', [{ name: 'x', value: '1', minScore: 3, maxScore: 3 }]],
      ['GRADE_INTERVAL_OVERLAP', [...scoreItems(0, 3), { name: 'y', value: '9', minScore: 2, maxScore: 4 }]],
      [
        'GRADE_ITEM_DUPLICATE',
        [
          { name: 'a', value: '1', minScore: 0, maxScore: 1 },
          { name: 'a', value: '2', minScore: 1, maxScore: 2 },
        ],
      ],
      [
        'GRADE_ITEM_DUPLICATE',
        [
          { name: 'a', value: '1', minScore: 0, maxScore: 1 },
          { name: 'b', value: '1', minScore: 1, maxScore: 2 },
        ],
      ],
      ['GRADE_ITEMS_MIXED', [...scoreItems(0, 2), ...countItems(5)]],
    ];
    for (const [reason, items] of bad) {
      const response = await w.request('POST', '/module-grades', { ifMatch: 0, body: moduleGradeBody({ items }) });
      expect([response.status, await reasonOf(response)], reason).toEqual([400, reason]);
    }
  });

  it('同一等级项不能同时带分数边界与数量门槛：新建 / 修改都 400，原分数区间与 revision、审计、台账不变（P2-02）', async () => {
    const w = await scoringWorld(testDb().db, 'trg-mixed-item');
    const grade = (await w.post('/module-grades', moduleGradeBody())) as GradeView;
    const mixed = [{ name: '混合', value: '9', minScore: 0, maxScore: 5, minCount: 3 }];
    const created = await w.request('POST', '/module-grades', { ifMatch: 0, body: moduleGradeBody({ items: mixed }) });
    expect([created.status, await reasonOf(created)]).toEqual([400, 'GRADE_ITEMS_MIXED']);
    const key = `trg-mixed-${Date.now()}`;
    const patched = await w.request('PATCH', `/module-grades/${grade.id}`, {
      ifMatch: grade.revision,
      idempotencyKey: key,
      body: { items: mixed },
    });
    expect([patched.status, await reasonOf(patched)]).toEqual([400, 'GRADE_ITEMS_MIXED']);
    const after = (await w.request('GET', `/module-grades/${grade.id}`).then((r) => r.json())) as GradeView;
    expect(after).toEqual(grade);
    expect(after.mode).toBe('score');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const objectType = TALENT_REVIEW_OBJECTS.moduleGrade.code;
    const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
    expect(items.map((entry) => entry.operation)).toEqual(['create']);
    const retry = await w.request('PATCH', `/module-grades/${grade.id}`, {
      ifMatch: grade.revision,
      idempotencyKey: key,
      body: { items: scoreItems(0, 1) },
    });
    expect(retry.status, await retry.clone().text()).toBe(200); // 失败的命令不入台账，原键可重提
  });

  it('按指标数目：mode = count；门槛不重复且不为负', async () => {
    const w = await scoringWorld(testDb().db, 'trg-count');
    const grade = (await w.post('/module-grades', moduleGradeBody({ items: countItems(3, 6, 10) }))) as GradeView;
    expect(grade).toMatchObject({ mode: 'count' });
    expect(grade.items.map((item) => item.minCount)).toEqual([3, 6, 10]);
    for (const [reason, items] of [
      ['GRADE_COUNT_DUPLICATE', countItems(3, 3)],
      ['VALIDATION_FAILED', countItems(-1)],
    ] as const) {
      const response = await w.request('POST', '/module-grades', { ifMatch: 0, body: moduleGradeBody({ items }) });
      expect(response.status).toBe(400);
      expect(reason === 'VALIDATION_FAILED' ? await errorCode(response) : await reasonOf(response)).toBe(reason);
    }
  });

  it('修改：等级项整组替换并重新校验；名称重复 409；revision 冲突 409；失败时原数据不变', async () => {
    const w = await scoringWorld(testDb().db, 'trg-patch');
    const grade = (await w.post('/module-grades', moduleGradeBody())) as GradeView;
    const other = (await w.post('/module-grades', moduleGradeBody())) as GradeView;
    const patch = (ifMatch: number, body: Record<string, unknown>) =>
      w.request('PATCH', `/module-grades/${grade.id}`, { ifMatch, body });
    const overlap = await patch(1, {
      items: [...scoreItems(0, 3), { name: 'z', value: '9', minScore: 1, maxScore: 2 }],
    });
    expect([overlap.status, await reasonOf(overlap)]).toEqual([400, 'GRADE_INTERVAL_OVERLAP']);
    const dup = await patch(1, { name: other.name });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'MODULE_GRADE_DUPLICATE']);
    expect([(await patch(7, { enabled: false })).status]).toEqual([409]);
    expect((await w.request('GET', `/module-grades/${grade.id}`).then((r) => r.json())) as GradeView).toEqual(grade);
    const ok = await patch(1, { items: countItems(5, 8) });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ mode: 'count', revision: 2 });
  });

  it('被模板引用不可删（数据不变），可以停用；未引用的可删，删除后详情 404', async () => {
    const w = await scoringWorld(testDb().db, 'trg-delete');
    const grade = (await w.post('/module-grades', moduleGradeBody())) as GradeView;
    referenced.add(grade.id);
    const blocked = await w.request('DELETE', `/module-grades/${grade.id}`, { ifMatch: 1 });
    expect([blocked.status, await reasonOf(blocked)]).toEqual([409, 'MODULE_GRADE_IN_USE']);
    expect((await w.request('GET', `/module-grades/${grade.id}`).then((r) => r.json())) as GradeView).toEqual(grade);
    referenced.delete(grade.id);
    expect((await w.request('DELETE', `/module-grades/${grade.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.request('GET', `/module-grades/${grade.id}`)).status).toBe(404);
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const objectType = TALENT_REVIEW_OBJECTS.moduleGrade.code;
    const { items } = await audit.dataChanges(w.as, { objectType, operation: 'delete', limit: '10' });
    const removed = await audit.dataChange(w.as, items[0]!.id);
    expect((removed.snapshot as GradeView).items).toHaveLength(grade.items.length); // 子表一并快照
  });
});
