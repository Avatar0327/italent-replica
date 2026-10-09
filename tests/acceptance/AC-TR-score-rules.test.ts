/**
 * R3-T04 PR-B2 评价规则（设计 §2.2 score_rules / _levels、TR-R20；DEC-067、DEC-216）：
 * - 数值类：最小分、最大分（最大 > 最小），不带等级；等级类：至少一个等级（名称 + 对应分值），下拉或平铺，不带分值范围；
 * - 可启用“无法评价”；规则类型建后不可改；修改等级整组替换；名称租户唯一；
 * - 写入口 If-Match revision 与幂等键；被模板引用不可删（引用方登记守卫，409 SCORE_RULE_IN_USE）；
 * - 创建审计含完整等级（先写子数据再取快照），修改只记改动字段，删除带快照；其他租户读不到。
 * 负向用例断言具体响应码，并前后各读一次对比。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { auditApi } from './AC-AUD-support.js';
import {
  gradeRuleBody,
  levels,
  scoreRuleBody,
  scoringWorld,
  TR_NOW,
  type ConfigView,
} from './AC-TR-scoring-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('scoreRule', async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_TEMPLATE' : null));
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;
interface RuleView extends ConfigView {
  readonly kind: string;
  readonly minScore: number | null;
  readonly maxScore: number | null;
  readonly display: string | null;
  readonly allowUnable: boolean;
  readonly levels: { name: string; value: number; sortNo: number }[];
}

describe('评价规则 · 数值类 / 等级类（TR-R20）', () => {
  it('数值类：分值范围以数字返回；最大分须大于最小分；不带等级和显示方式；可启用无法评价', async () => {
    const w = await scoringWorld(testDb().db, 'trs-numeric');
    const rule = (await w.post('/score-rules', scoreRuleBody({ allowUnable: true }))) as RuleView;
    expect(rule).toMatchObject({
      kind: 'numeric',
      minScore: 1,
      maxScore: 5,
      display: null,
      allowUnable: true,
      levels: [],
    });
    const bad: [string, Record<string, unknown>][] = [
      ['SCORE_RANGE_INVALID', scoreRuleBody({ minScore: 5, maxScore: 5 })],
      ['SCORE_RANGE_INVALID', scoreRuleBody({ minScore: 6, maxScore: 5 })],
      ['SCORE_RANGE_INVALID', scoreRuleBody({ minScore: undefined })],
      ['SCORE_LEVELS_NOT_ALLOWED', scoreRuleBody({ levels: levels('高') })],
      ['SCORE_FIELD_NOT_APPLICABLE', scoreRuleBody({ display: 'tile' })],
    ];
    for (const [reason, body] of bad) {
      const response = await w.request('POST', '/score-rules', { ifMatch: 0, body });
      expect([response.status, await reasonOf(response)], reason).toEqual([400, reason]);
    }
  });

  it('等级类：至少一个等级；等级名称不重复；下拉或平铺（缺省下拉）；不带分值范围', async () => {
    const w = await scoringWorld(testDb().db, 'trs-grade');
    const tile = (await w.post('/score-rules', gradeRuleBody({ display: 'tile' }))) as RuleView;
    expect(tile).toMatchObject({ kind: 'grade', display: 'tile', minScore: null, maxScore: null });
    expect(tile.levels.map((level) => [level.name, level.value])).toEqual([
      ['高', 3],
      ['中', 2],
      ['低', 1],
    ]);
    const defaulted = (await w.post('/score-rules', gradeRuleBody({ display: undefined }))) as RuleView;
    expect(defaulted.display).toBe('dropdown');
    const bad: [string, Record<string, unknown>][] = [
      ['SCORE_LEVELS_REQUIRED', gradeRuleBody({ levels: [] })],
      ['SCORE_LEVEL_DUPLICATE', gradeRuleBody({ levels: [...levels('高'), ...levels('高')] })],
      ['SCORE_FIELD_NOT_APPLICABLE', gradeRuleBody({ minScore: 1, maxScore: 5 })],
    ];
    for (const [reason, body] of bad) {
      const response = await w.request('POST', '/score-rules', { ifMatch: 0, body });
      expect([response.status, await reasonOf(response)], reason).toEqual([400, reason]);
    }
    const strict = await w.request('POST', '/score-rules', { ifMatch: 0, body: gradeRuleBody({ display: 'grid' }) });
    expect([strict.status, await errorCode(strict)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('修改：类型建后不可改；等级整组替换；改范围按合并后的值校验；名称重复 409；数据不变', async () => {
    const w = await scoringWorld(testDb().db, 'trs-patch');
    const numeric = (await w.post('/score-rules', scoreRuleBody())) as RuleView;
    const grade = (await w.post('/score-rules', gradeRuleBody())) as RuleView;
    const patch = (id: string, ifMatch: number, body: Record<string, unknown>) =>
      w.request('PATCH', `/score-rules/${id}`, { ifMatch, body });
    const kind = await patch(numeric.id, 1, { kind: 'grade' });
    expect([kind.status, await errorCode(kind)]).toEqual([400, 'VALIDATION_FAILED']);
    expect([
      (await patch(numeric.id, 1, { maxScore: 1 })).status,
      (await patch(numeric.id, 1, { minScore: 9 })).status,
    ]).toEqual([400, 400]);
    const wrongLevels = await patch(numeric.id, 1, { levels: levels('高') });
    expect([wrongLevels.status, await reasonOf(wrongLevels)]).toEqual([400, 'SCORE_LEVELS_NOT_ALLOWED']);
    const wrongRange = await patch(grade.id, 1, { minScore: 1 });
    expect([wrongRange.status, await reasonOf(wrongRange)]).toEqual([400, 'SCORE_FIELD_NOT_APPLICABLE']);
    const dup = await patch(numeric.id, 1, { name: grade.name });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'SCORE_RULE_DUPLICATE']);
    expect((await w.request('GET', `/score-rules/${numeric.id}`)).status).toBe(200);
    const ok = await patch(grade.id, 1, { levels: levels('优', '良'), allowUnable: true });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const updated = (await ok.json()) as RuleView;
    expect(updated).toMatchObject({ revision: 2, allowUnable: true });
    expect(updated.levels.map((level) => [level.name, level.value])).toEqual([
      ['优', 2],
      ['良', 1],
    ]);
    const widened = await patch(numeric.id, 1, { maxScore: 10 });
    expect(await widened.json()).toMatchObject({ minScore: 1, maxScore: 10, revision: 2 });
  });
});

describe('评价规则 · 通用写入规则（DEC-067 / DEC-216）', () => {
  it('列表按名称、详情带 ETag；revision 冲突 409；同幂等键重放首次结果、异内容 409；其他租户看不到', async () => {
    const db = testDb().db;
    const w = await scoringWorld(db, 'trs-crud');
    const other = await scoringWorld(db, 'trs-crud-other');
    const b = (await w.post('/score-rules', scoreRuleBody({ name: 'B 规则' }))) as RuleView;
    const a = (await w.post('/score-rules', scoreRuleBody({ name: 'A 规则', enabled: false }))) as RuleView;
    const list = (await (await w.request('GET', '/score-rules')).json()) as { items: { id: string }[] };
    expect(list.items.map((item) => item.id)).toEqual([a.id, b.id]);
    const enabled = (await (await w.request('GET', '/score-rules?enabled=true')).json()) as { items: { id: string }[] };
    expect(enabled.items.map((item) => item.id)).toEqual([b.id]);
    expect((await w.request('GET', `/score-rules/${b.id.toUpperCase()}`)).headers.get('etag')).toBe('"1"');
    expect((await other.request('GET', `/score-rules/${b.id}`)).status).toBe(404);
    const stale = await w.request('PATCH', `/score-rules/${b.id}`, { ifMatch: 9, body: { enabled: false } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    const options = { ifMatch: 1, idempotencyKey: 'trs-patch-1', body: { allowUnable: true } };
    const first = await w.request('PATCH', `/score-rules/${b.id}`, options);
    const replay = await w.request('PATCH', `/score-rules/${b.id}`, options);
    expect([replay.status, await replay.json()]).toEqual([200, await first.json()]);
    const conflict = await w.request('PATCH', `/score-rules/${b.id}`, { ...options, body: { allowUnable: false } });
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('被模板引用不可删（数据不变），可以停用；未引用的可删，删除后详情 404', async () => {
    const w = await scoringWorld(testDb().db, 'trs-delete');
    const rule = (await w.post('/score-rules', gradeRuleBody())) as RuleView;
    referenced.add(rule.id);
    const blocked = await w.request('DELETE', `/score-rules/${rule.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'SCORE_RULE_IN_USE', referrer: 'TEST_TEMPLATE' } },
    });
    expect(((await (await w.request('GET', `/score-rules/${rule.id}`)).json()) as RuleView).levels).toHaveLength(3);
    expect((await w.request('PATCH', `/score-rules/${rule.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(
      200,
    );
    referenced.delete(rule.id);
    const removed = await w.request('DELETE', `/score-rules/${rule.id}`, { ifMatch: 2 });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as RuleView).levels).toHaveLength(3);
    expect((await w.request('GET', `/score-rules/${rule.id}`)).status).toBe(404);
  });

  it('创建审计含完整等级；修改只记改动字段；删除带快照', async () => {
    const w = await scoringWorld(testDb().db, 'trs-audit');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const rule = (await w.post('/score-rules', gradeRuleBody())) as RuleView;
    await w.request('PATCH', `/score-rules/${rule.id}`, { ifMatch: 1, body: { name: '改名' } });
    await w.request('DELETE', `/score-rules/${rule.id}`, { ifMatch: 2 });
    const objectType = TALENT_REVIEW_OBJECTS.scoreRule.code;
    const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete', 'update']);
    const created = items.find((entry) => entry.operation === 'create')!;
    expect(created.changes.map((change) => change.field)).toContain('levels');
    expect(((await audit.dataChange(w.as, created.id)).after as RuleView).levels).toHaveLength(3);
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['name']);
    const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({ id: rule.id, name: '改名' });
  });
});
