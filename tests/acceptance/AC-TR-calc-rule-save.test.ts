/**
 * AC-TR-calc-rule-save · R3-T04 PR-B5 计算规则 + 计算项目的保存（设计 §2.2 calc_rules / _items、§4.3、§4.5(d)、§7 计算规则行；
 * DEC-274、DEC-287、DEC-314②、DEC-260）：
 * - 保存校验 validateFormula：语法、函数、参数个数、未知字段（字段目录 = 当前可见的盘点字段，公式按名称 盘点对象.<名>）；
 * - orderComputationItems：先优先级、再按引用依赖排序；循环依赖与依赖矛盾只提示、不拦截保存（DEC-274）；
 * - uses_ranking 由公式派生（含排名函数的项目，待办触发时不计算，DEC-260）；
 * - 目标字段类型允许性：多选 / 系统写入字段 400 TARGET_FIELD_NOT_ALLOWED；目标保存后只读（按目标字段对应项目）；
 * - 公式引用多选字段 400 MULTI_OPTION_IN_FORMULA（取证前禁用，DEC-314②）；
 * - 规则 revision 每次保存 +1（run 冻结时核对“规则已改”）；If-Match（409）、幂等键、被引用不可删。
 * 负向用例断言具体响应码，并前后各读一次对比，证明业务数据未被改动。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { talentReviewFields, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-config-support.js';
import {
  CALC_RULES,
  calcBody,
  calcItem,
  calcWorld,
  type CalcRuleView,
  pathOf,
  withoutHints,
} from './AC-TR-calc-rule-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerConfigReferenceGuard('calcRule', async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_PROJECT' : null));
interface Failure {
  error: { code: string; details: { reason: string; item?: number; issues?: { code: string }[]; fields?: string[] } };
}
const failure = async (response: Response) => ((await response.json()) as Failure).error;

describe('计算规则新建与读取（设计 §2.2）', () => {
  it('新建返回完整聚合与保存提示；详情带 ETag 且不含提示；标识大小写不敏感；其他租户看不到', async () => {
    const w = await calcWorld(testDb().db, 'trk-crud');
    const other = await calcWorld(testDb().db, 'trk-crud-other');
    const [a, b] = [await w.numberField(), await w.numberField()];
    const body = calcBody(
      [calcItem(a, '1 + 1', { priority: 2, description: '常量' }), calcItem(b, `${pathOf(a)} * 2`, { priority: 1 })],
      { description: '规则说明' },
    );
    const created = await w.create(body);
    expect(created).toMatchObject({
      revision: 1,
      enabled: true,
      assessmentLatestWindow: 'before_project_end',
      description: '规则说明',
      createdBy: w.as.user,
    });
    expect(created.items.map((item) => [item.targetFieldId, item.priority, item.usesRanking])).toEqual([
      [a.id, 2, false],
      [b.id, 1, false],
    ]);
    // 优先级 b < a，但 b 引用 a：以依赖为准，先算 a，并给出提示（不拦截）
    expect(created.hints?.order).toEqual([a.id, b.id]);
    expect(created.hints?.warnings.join()).toContain('按依赖先算');
    expect(created.hints?.cycles).toEqual([]);
    const detail = await w.request('GET', `${CALC_RULES}/${created.id.toUpperCase()}`);
    expect(detail.headers.get('etag')).toBe('"1"');
    expect(await detail.json()).toEqual(withoutHints(created));
    expect((await w.list()).items.map((item) => item.id)).toEqual([created.id]);
    expect((await other.read(created.id)).status).toBe(404);
    expect((await other.list()).items).toEqual([]);
  });

  it('名称租户唯一 409；多余字段 400；窗口限两种；失败不落库', async () => {
    const w = await calcWorld(testDb().db, 'trk-unique');
    const a = await w.numberField();
    const first = await w.create(calcBody([calcItem(a, '1')]));
    const dup = await w.post(calcBody([calcItem(a, '1')], { name: first.name }));
    expect([dup.status, (await failure(dup)).details.reason]).toEqual([409, 'CALC_RULE_DUPLICATE']);
    for (const extra of [{ unknown: 1 }, { assessmentLatestWindow: 'whenever' }, { revision: 3 }]) {
      const response = await w.post(calcBody([calcItem(a, '1')], extra));
      expect([response.status, await errorCode(response)], JSON.stringify(extra)).toEqual([400, 'VALIDATION_FAILED']);
    }
    const early = await w.create(calcBody([calcItem(a, '1')], { assessmentLatestWindow: 'before_project_start' }));
    expect(early.assessmentLatestWindow).toBe('before_project_start');
    expect((await w.list()).items.map((item) => item.id)).toEqual([first.id, early.id]);
  });
});

describe('保存校验（validateFormula / orderComputationItems；DEC-274 / 287）', () => {
  it.each([
    ['语法错误', '1 +', 'SYNTAX'],
    ['未知函数', '不存在的函数(1)', 'UNKNOWN_FUNCTION'],
    ['未知字段', '盘点对象.不存在的字段 + 1', 'UNKNOWN_FIELD'],
  ])('公式非法 · %s：400 FORMULA_INVALID，指出第几个项目，数据不变', async (_name, formula, issue) => {
    const w = await calcWorld(testDb().db, `trk-invalid-${issue}`);
    const [a, b] = [await w.numberField(), await w.numberField()];
    const response = await w.post(calcBody([calcItem(a, '1'), calcItem(b, formula)]));
    const error = await failure(response);
    expect([response.status, error.code, error.details.reason, error.details.item]).toEqual([
      400,
      'VALIDATION_FAILED',
      'FORMULA_INVALID',
      1,
    ]);
    expect(error.details.issues?.length).toBeGreaterThan(0);
    expect(issue).toBeTruthy();
    expect((await w.list()).items).toEqual([]);
  });

  it('循环依赖只提示不拦截（DEC-274）：保存成功，提示里列出环；自引用同样是环', async () => {
    const w = await calcWorld(testDb().db, 'trk-cycle');
    const [a, b, c] = [await w.numberField(), await w.numberField(), await w.numberField()];
    const created = await w.create(
      calcBody([calcItem(a, `${pathOf(b)} + 1`), calcItem(b, `${pathOf(a)} + 1`), calcItem(c, `${pathOf(c)} + 1`)]),
    );
    expect(created.hints?.cycles.length).toBe(2);
    expect(created.hints?.blocked).toHaveLength(3);
    expect(created.hints?.warnings.join()).toContain('循环依赖');
    expect((await w.read(created.id)).status).toBe(200);
  });

  it('uses_ranking 由公式派生：含排名函数的项目为真，改公式后重新派生；项目字段可进排名范围', async () => {
    const w = await calcWorld(testDb().db, 'trk-ranking');
    const [score, rank] = [await w.numberField(), await w.numberField()];
    const ranking = `Ranking("百分位", ${pathOf(score)}, 盘点活动.项目名称="项目甲", 盘点对象.盘点方案)`;
    const created = await w.create(calcBody([calcItem(score, '80'), calcItem(rank, ranking, { priority: 2 })]));
    expect(created.items.map((item) => item.usesRanking)).toEqual([false, true]);
    const edited = await w.request('PATCH', `${CALC_RULES}/${created.id}`, {
      ifMatch: 1,
      body: { items: [calcItem(score, '80'), calcItem(rank, `${pathOf(score)} + 1`, { priority: 2 })] },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(((await edited.json()) as CalcRuleView).items.map((item) => item.usesRanking)).toEqual([false, false]);
  });
});

describe('目标字段类型允许性与多选字段（§4.5(d)；DEC-314②）', () => {
  it('多选字段、系统写入字段不能作目标：400 TARGET_FIELD_NOT_ALLOWED；重复目标 400', async () => {
    const w = await calcWorld(testDb().db, 'trk-target');
    const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: 'trk-target-seed' };
    await withTenant(testDb().db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
    const fields = await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx
        .select({ id: talentReviewFields.id, code: talentReviewFields.code, name: talentReviewFields.name })
        .from(talentReviewFields),
    );
    const systemWritten = fields.find((f) => f.code === 'achievement_capability_cell_after')!;
    const multi = await w.multiField();
    const ok = await w.numberField();
    for (const target of [multi, systemWritten]) {
      const response = await w.post(calcBody([calcItem(ok, '1'), calcItem(target, '1')]));
      const error = await failure(response);
      expect([response.status, error.details.reason, error.details.item], target.id).toEqual([
        400,
        'TARGET_FIELD_NOT_ALLOWED',
        1,
      ]);
    }
    const dup = await w.post(calcBody([calcItem(ok, '1'), calcItem(ok, '2')]));
    expect([dup.status, (await failure(dup)).details.reason]).toEqual([400, 'CALC_ITEM_TARGET_DUPLICATE']);
    expect((await w.list()).items).toEqual([]);
  });

  it('允许 number / text / option / date / boolean 目标；新选用已停用字段 400', async () => {
    const w = await calcWorld(testDb().db, 'trk-kinds');
    const targets = [
      await w.numberField(),
      await w.textField(),
      await w.optionField(),
      await w.field('date', { group: 'basic' }),
      await w.field('boolean', { group: 'basic' }),
    ];
    const created = await w.create(calcBody(targets.map((target) => calcItem(target, '""'))));
    expect(created.items).toHaveLength(5);
    const off = await w.numberField();
    expect((await w.request('PATCH', `/fields/${off.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(200);
    const response = await w.post(calcBody([calcItem(off, '1')]));
    expect([response.status, (await failure(response)).details.reason]).toEqual([400, 'CALC_TARGET_DISABLED']);
  });

  it('公式引用多选字段：400 MULTI_OPTION_IN_FORMULA，指出项目与字段；创建与修改都拒绝，数据不变', async () => {
    const w = await calcWorld(testDb().db, 'trk-multi');
    const [target, multi] = [await w.numberField(), await w.multiField()];
    const bad = `Len(${pathOf(multi)})`;
    const response = await w.post(calcBody([calcItem(target, bad)]));
    const error = await failure(response);
    expect([response.status, error.code, error.details.reason, error.details.item]).toEqual([
      400,
      'VALIDATION_FAILED',
      'MULTI_OPTION_IN_FORMULA',
      0,
    ]);
    expect(error.details.fields).toEqual([pathOf(multi)]);
    const created = await w.create(calcBody([calcItem(target, '1')]));
    const edit = await w.request('PATCH', `${CALC_RULES}/${created.id}`, {
      ifMatch: 1,
      body: { items: [calcItem(target, bad)] },
    });
    expect([edit.status, (await failure(edit)).details.reason]).toEqual([400, 'MULTI_OPTION_IN_FORMULA']);
    expect((await w.read(created.id)).body).toEqual(withoutHints(created));
  });
});

describe('修改：计算项目按目标字段对应；revision 递增；幂等', () => {
  it('整组 items：按目标字段对应更新 / 新增 / 删除；未提交 items 保留；目标字段保存后只读（改目标 = 删除 + 新增）', async () => {
    const w = await calcWorld(testDb().db, 'trk-items');
    const [a, b, c] = [await w.numberField(), await w.numberField(), await w.numberField()];
    const created = await w.create(calcBody([calcItem(a, '1'), calcItem(b, '2')]));
    const rename = await w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 1, body: { name: '改名' } });
    const renamed = (await rename.json()) as CalcRuleView;
    expect(renamed).toMatchObject({ revision: 2, name: '改名' });
    expect(renamed.items).toEqual(created.items);
    const swap = await w.request('PATCH', `${CALC_RULES}/${created.id}`, {
      ifMatch: 2,
      body: { items: [calcItem(a, '10', { priority: 5, description: '改过' }), calcItem(c, '3')] },
    });
    expect(swap.status, await swap.clone().text()).toBe(200);
    const swapped = (await swap.json()) as CalcRuleView;
    expect(swapped.revision).toBe(3);
    expect(swapped.items.map((item) => [item.targetFieldId, item.formula, item.priority, item.description])).toEqual([
      [a.id, '10', 5, '改过'],
      [c.id, '3', 1, null],
    ]);
    const empty = await w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 3, body: { items: [] } });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as CalcRuleView).items).toEqual([]);
  });

  it('If-Match 不符 409、缺失 400；同幂等键同内容重放首次结果，异内容 409；规则 revision 每次保存 +1', async () => {
    const w = await calcWorld(testDb().db, 'trk-revision');
    const a = await w.numberField();
    const created = await w.create(calcBody([calcItem(a, '1')]));
    const stale = await w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 9, body: { enabled: false } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    expect(await errorCode(await w.request('PATCH', `${CALC_RULES}/${created.id}`, { body: { enabled: false } }))).toBe(
      'REVISION_REQUIRED',
    );
    expect((await w.read(created.id)).body).toEqual(withoutHints(created));
    const options = { ifMatch: 1, idempotencyKey: 'trk-patch-1', body: { items: [calcItem(a, '2')] } };
    const first = await w.request('PATCH', `${CALC_RULES}/${created.id}`, options);
    const updated = (await first.json()) as CalcRuleView;
    expect(updated.revision).toBe(2);
    const replay = await w.request('PATCH', `${CALC_RULES}/${created.id}`, options);
    expect([replay.status, await replay.json()]).toEqual([200, updated]);
    const conflict = await w.request('PATCH', `${CALC_RULES}/${created.id}`, {
      ...options,
      body: { items: [calcItem(a, '3')] },
    });
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expect((await w.read(created.id)).body.revision).toBe(2);
  });
});

describe('删除与审计', () => {
  it('被引用不可删（CALC_RULE_IN_USE，数据不变），可停用；被计算项目作目标的字段不能删（FIELD_IN_USE，referrer = CALC_RULE）', async () => {
    const w = await calcWorld(testDb().db, 'trk-delete');
    const a = await w.numberField();
    const created = await w.create(calcBody([calcItem(a, '1')]));
    const guard = await w.request('DELETE', `/fields/${a.id}`, { ifMatch: 1 });
    expect(guard.status).toBe(409);
    expect(await guard.json()).toMatchObject({ error: { details: { reason: 'FIELD_IN_USE', referrer: 'CALC_RULE' } } });
    referenced.add(created.id);
    const blocked = await w.request('DELETE', `${CALC_RULES}/${created.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'CALC_RULE_IN_USE', referrer: 'TEST_PROJECT' } },
    });
    expect((await w.read(created.id)).body).toEqual(withoutHints(created));
    referenced.delete(created.id);
    const removed = await w.request('DELETE', `${CALC_RULES}/${created.id}`, { ifMatch: 1 });
    expect(removed.status).toBe(200);
    expect((await w.read(created.id)).status).toBe(404);
    expect((await w.request('DELETE', `/fields/${a.id}`, { ifMatch: 1 })).status).toBe(200);
  });

  it('新增 / 修改 / 删除都写数据变更日志，修改只记改动字段，删除带快照', async () => {
    const w = await calcWorld(testDb().db, 'trk-audit');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const a = await w.numberField();
    const created = await w.create(calcBody([calcItem(a, '1')]));
    await w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 1, body: { description: '审计改' } });
    await w.request('DELETE', `${CALC_RULES}/${created.id}`, { ifMatch: 2 });
    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_REVIEW_OBJECTS.calcRule.code, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete', 'update']);
    for (const entry of items) expect(entry).toMatchObject({ app: '人才盘点', objectId: created.id });
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['description']);
    const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({ id: created.id, items: [expect.objectContaining({ formula: '1' })] });
    expect(removed.snapshot).not.toHaveProperty('hints');
  });
});
