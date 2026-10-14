/**
 * F-082 AC-01～04、11～14、24（F082-3，开关打开；契约 §1.4～§1.7、§2、§9）：
 * 保存按名称输入、库里存规范文本（句柄）+ 引用表；GET / 写响应 / 重放按当前名称渲染并给出逐处绑定 formulaBindings；
 * 改名自动跟随；绑定证明与字段目录版本拦下旧页面换绑；重名回显；句柄不可注入；盘点方案选择；裸词；跨租户。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { CALC_RULES, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import {
  boundWorld,
  calcBody,
  calcItem,
  catalogVersion,
  errorOf,
  fieldHandle,
  itemIdOf,
  rawItem,
  refsOf,
  renameField,
  type F082World,
} from './AC-TR-F082-support.js';

const testDb = useTestDb();
const db = () => testDb().db;

/** 带当前字段目录版本提交（新输入的引用必须带版本，契约 §1.5）。 */
async function ruleBody(w: F082World, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return calcBody(items, { fieldCatalogVersion: await catalogVersion(db(), w), ...extra });
}
async function save(w: F082World, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return w.post(await ruleBody(w, items, extra));
}
const patchItems = async (w: F082World, rule: CalcRuleView, items: Record<string, unknown>[], version?: number) =>
  w.request('PATCH', `${CALC_RULES}/${rule.id}`, {
    ifMatch: rule.revision,
    body: { items, fieldCatalogVersion: version ?? (await catalogVersion(db(), w)) },
  });
const created = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as CalcRuleView;
};
const reasonOf = async (response: Response) => (await errorOf(response)).details['reason'];

describe('AC-01 绑定：库里是句柄 + 引用表；读回名称与 formulaBindings', () => {
  it('按名称保存（含空白 / 换行写法）→ 规范文本；引用表与句柄一致；GET / 写响应 / 重放读回名称', async () => {
    const w = await boundWorld(db(), 'f082-b01');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const body = await ruleBody(w, [calcItem(target, `盘点对象 .\n ${source.name} + 1`)]);
    const key = 'f082-b01-key';
    const response = await w.post(body, { idempotencyKey: key });
    const rule = await created(response);
    const shown = `盘点对象.${source.name} + 1`;
    expect(rule.items[0]).toMatchObject({ formula: shown, formulaBindings: [source.id] });
    expect(typeof rule['fieldCatalogVersion']).toBe('number');
    // 库里是规范文本（句柄），状态 bound，引用表恰好是这个字段
    const itemId = await itemIdOf(db(), w, rule.id, target.id);
    expect(await rawItem(db(), w, itemId)).toMatchObject({
      formula: `${fieldHandle(source.id)} + 1`,
      formula_binding: 'bound',
      binding_issue: null,
    });
    expect(await refsOf(db(), w, itemId)).toEqual([{ item_id: itemId, field_id: source.id, kind: 'bound' }]);
    // GET 与重放读回同样的名称与绑定
    const read = await w.read(rule.id);
    expect(read.body.items[0]).toMatchObject({ formula: shown, formulaBindings: [source.id] });
    const replay = await w.post(body, { idempotencyKey: key });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as CalcRuleView).items[0]).toMatchObject({
      formula: shown,
      formulaBindings: [source.id],
    });
    // 列表同样
    const listed = (await w.list()).items.find((entry) => entry.id === rule.id)!;
    expect(listed.items[0]).toMatchObject({ formula: shown, formulaBindings: [source.id] });
  });

  it('项目上下文路径与字符串里的“盘点对象.x”不进引用表；多处引用逐处给出绑定', async () => {
    const w = await boundWorld(db(), 'f082-b01b');
    const [target, a, b] = [await w.numberField(), await w.numberField(), await w.numberField()];
    const formula = `盘点对象.${a.name} + Len("盘点对象.${b.name}") + 盘点对象.${a.name}`;
    const rule = await created(await save(w, [calcItem(target, formula)]));
    expect(rule.items[0]).toMatchObject({ formula, formulaBindings: [a.id, a.id] });
    const itemId = await itemIdOf(db(), w, rule.id, target.id);
    expect((await refsOf(db(), w, itemId)).map((row) => row.field_id)).toEqual([a.id]);
  });
});

describe('AC-02 改名跟随', () => {
  it('改名后 GET 显示新名、规则 revision 不变；带原 ID 用新名重提 → 200；带原 ID 用旧名重提 → 409 CALC_BINDING_STALE', async () => {
    const w = await boundWorld(db(), 'f082-b02');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const rule = await created(await save(w, [calcItem(target, `盘点对象.${source.name} + 1`)]));
    const oldName = source.name;
    expect((await renameField(w, source, '改名之后')).status).toBe(200);
    const read = await w.read(rule.id);
    expect(read.body.revision).toBe(rule.revision);
    expect(read.body.items[0]).toMatchObject({ formula: '盘点对象.改名之后 + 1', formulaBindings: [source.id] });
    const fresh = await patchItems(w, read.body, [
      calcItem(target, '盘点对象.改名之后 + 1', { formulaBindings: [source.id] }),
    ]);
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    const stale = await patchItems(w, { ...read.body, revision: read.body.revision + 1 }, [
      calcItem(target, `盘点对象.${oldName} + 1`, { formulaBindings: [source.id] }),
    ]);
    expect([stale.status, await reasonOf(stale)]).toEqual([409, 'CALC_BINDING_STALE']);
  });

  it('改名后用原命令 ID 重放：不重新执行，读回新名称（契约 §5.4）', async () => {
    const w = await boundWorld(db(), 'f082-b02r');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const body = await ruleBody(w, [calcItem(target, `盘点对象.${source.name} + 1`)]);
    const first = await created(await w.post(body, { idempotencyKey: 'f082-b02r-key' }));
    expect((await renameField(w, source, '重放时的新名')).status).toBe(200);
    const replay = await w.post(body, { idempotencyKey: 'f082-b02r-key' });
    const again = (await replay.json()) as CalcRuleView;
    expect([replay.status, again.id]).toEqual([201, first.id]);
    expect(again.items[0]).toMatchObject({ formula: '盘点对象.重放时的新名 + 1', formulaBindings: [source.id] });
  });
});

describe('AC-03 旧页面换绑（P2-1①）', () => {
  it('id1 改名 C、id2 改名 A：旧页面带 id1 提交 → 409 CALC_BINDING_STALE；不带绑定带旧版本 → 409 FIELD_CATALOG_CHANGED', async () => {
    const w = await boundWorld(db(), 'f082-b03');
    const target = await w.numberField();
    const id1 = await w.field('number', { name: '甲A' });
    const id2 = await w.field('number', { name: '乙B' });
    const rule = await created(await save(w, [calcItem(target, '盘点对象.甲A + 1')]));
    const staleVersion = await catalogVersion(db(), w);
    expect((await renameField(w, id1, '丙C')).status).toBe(200);
    expect((await renameField(w, id2, '甲A')).status).toBe(200);
    const withProof = await patchItems(w, rule, [calcItem(target, '盘点对象.甲A + 1', { formulaBindings: [id1.id] })]);
    expect([withProof.status, await reasonOf(withProof)]).toEqual([409, 'CALC_BINDING_STALE']);
    const noProof = await patchItems(w, rule, [calcItem(target, '盘点对象.甲A + 1')], staleVersion);
    expect([noProof.status, await reasonOf(noProof)]).toEqual([409, 'FIELD_CATALOG_CHANGED']);
    // 两种情况都没有写入，原规则仍引用 id1（现在叫“丙C”）
    const read = await w.read(rule.id);
    expect(read.body.revision).toBe(rule.revision);
    expect(read.body.items[0]).toMatchObject({ formula: '盘点对象.丙C + 1', formulaBindings: [id1.id] });
  });
});

describe('AC-04 重名回显（P2-1②）', () => {
  it('A 改名为 B 后回显 B+B，原样带绑定重提 → 200 绑定不变；新输入 `盘点对象.B` → 400 CALC_FIELD_NAME_AMBIGUOUS；目标字段重名可保存', async () => {
    const w = await boundWorld(db(), 'f082-b04');
    const target = await w.numberField();
    const a = await w.field('number', { name: '字段A' });
    const b = await w.field('number', { name: '字段B' });
    const rule = await created(await save(w, [calcItem(target, '盘点对象.字段A + 盘点对象.字段B')]));
    expect((await renameField(w, a, '字段B')).status).toBe(200);
    const read = await w.read(rule.id);
    expect(read.body.items[0]).toMatchObject({
      formula: '盘点对象.字段B + 盘点对象.字段B',
      formulaBindings: [a.id, b.id],
    });
    const same = await patchItems(w, read.body, [
      calcItem(target, '盘点对象.字段B + 盘点对象.字段B', { formulaBindings: [a.id, b.id] }),
    ]);
    expect(same.status, await same.clone().text()).toBe(200);
    expect(((await same.json()) as CalcRuleView).items[0]!.formulaBindings).toEqual([a.id, b.id]);
    // 新输入遇到重名：400，不绑定
    const ambiguous = await save(w, [calcItem(target, '盘点对象.字段B + 1')]);
    const error = await errorOf(ambiguous);
    expect([ambiguous.status, error.details['reason']]).toEqual([400, 'CALC_FIELD_NAME_AMBIGUOUS']);
    // 目标字段与其他字段重名可以保存（B5 的“目标重名 400”作废）
    const twin = await w.field('number', { name: target.name });
    const ok = await save(w, [calcItem(twin, '1')]);
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
});

describe('AC-11 句柄不可注入；AC-13 裸词；AC-12 盘点方案', () => {
  it('提交含 `@{tr-field:<id>}` 的公式 → 400；字符串里的 `@{…}` 原样保存、原样读回，不进引用表', async () => {
    const w = await boundWorld(db(), 'f082-b11');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const injected = await save(w, [calcItem(target, `${fieldHandle(source.id)} + 1`)]);
    expect([injected.status, await reasonOf(injected)]).toEqual([400, 'FORMULA_INVALID']);
    const literal = `Len("${fieldHandle(source.id)}") + 1`;
    const rule = await created(await save(w, [calcItem(target, literal)]));
    expect(rule.items[0]!.formula).toBe(literal);
    const itemId = await itemIdOf(db(), w, rule.id, target.id);
    expect(await refsOf(db(), w, itemId)).toEqual([]);
    expect((await w.read(rule.id)).body.items[0]!.formula).toBe(literal);
  });

  it('裸词 → 400 FORMULA_INVALID/BARE_WORD 并提示 "A"；与可见字段同名时多提示字段写法；加引号通过；Def 变量不算', async () => {
    const w = await boundWorld(db(), 'f082-b13');
    const [target, named] = [await w.numberField(), await w.field('text', { name: '绩效结果1', group: 'evaluation' })];
    const bare = await save(w, [calcItem(target, `IF(盘点对象.${named.name} = A, 1, 0)`)]);
    const error = await errorOf(bare);
    expect([bare.status, error.details['reason']]).toEqual([400, 'FORMULA_INVALID']);
    expect(JSON.stringify(error.details['issues'])).toContain('BARE_WORD');
    expect(JSON.stringify(error.details['issues'])).toContain('作文本请写成 \\"A\\"');
    const withField = await save(w, [calcItem(target, `绩效结果1 + 1`)]);
    expect(JSON.stringify((await errorOf(withField)).details['issues'])).toContain(`盘点对象.绩效结果1`);
    expect((await save(w, [calcItem(target, `IF(盘点对象.${named.name} = "A", 1, 0)`)])).status).toBe(201);
    expect((await save(w, [calcItem(target, 'Def(x, 1); x + 1')])).status).toBe(201);
  });

  it('盘点方案：没有同名字段 → 项目上下文；有可见同名字段 → 400 RESERVED_PATH_AMBIGUOUS 带 choices；选择后保存成功', async () => {
    const w = await boundWorld(db(), 'f082-b12');
    const target = await w.numberField();
    const context = await created(await save(w, [calcItem(target, 'Len(盘点对象.盘点方案)')]));
    expect(context.items[0]).toMatchObject({ formula: 'Len(盘点对象.盘点方案)', formulaBindings: ['context'] });
    expect(await refsOf(db(), w, await itemIdOf(db(), w, context.id, target.id))).toEqual([]);

    const custom = await w.field('text', { name: '盘点方案', group: 'evaluation' });
    const ambiguous = await save(w, [calcItem(target, 'Len(盘点对象.盘点方案)')]);
    const error = await errorOf(ambiguous);
    expect([ambiguous.status, error.details['reason']]).toEqual([400, 'FORMULA_INVALID']);
    const issue = (error.details['issues'] as { code: string; choices?: string[] }[]).find(
      (entry) => entry.code === 'RESERVED_PATH_AMBIGUOUS',
    )!;
    expect(issue.choices).toEqual(['context', custom.id]);
    const picked = await created(
      await save(w, [calcItem(target, 'Len(盘点对象.盘点方案)', { formulaBindings: [custom.id] })]),
    );
    expect(picked.items[0]!.formulaBindings).toEqual([custom.id]);
    const chosenContext = await created(
      await save(w, [calcItem(target, 'Len(盘点对象.盘点方案)', { formulaBindings: ['context'] })]),
    );
    expect(chosenContext.items[0]!.formulaBindings).toEqual(['context']);
  });
});

describe('AC-14 跨租户', () => {
  it('绑定证明里的 ID 属于其他租户 → 400 UNKNOWN_FIELD；直接写入跨租户引用行被复合外键拒绝', async () => {
    const w = await boundWorld(db(), 'f082-b14');
    const other = await boundWorld(db(), 'f082-b14x');
    const [target, foreign] = [await w.numberField(), await other.numberField()];
    const response = await save(w, [
      calcItem(target, `盘点对象.${foreign.name} + 1`, { formulaBindings: [foreign.id] }),
    ]);
    const error = await errorOf(response);
    expect([response.status, error.details['reason']]).toEqual([400, 'FORMULA_INVALID']);
    expect(JSON.stringify(error.details['issues'])).toContain('UNKNOWN_FIELD');
    const rule = await created(await save(w, [calcItem(target, '1')]));
    const itemId = await itemIdOf(db(), w, rule.id, target.id);
    const direct = await withTenant(db(), w.as.tenant, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_calc_item_refs (tenant_id, item_id, field_id, kind)
        VALUES (${w.as.tenant}, ${itemId}, ${foreign.id}, 'bound')`),
    ).catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(Error);
  });
});

describe('AC-24 优先级', () => {
  it('1000001 与 -1 → 400（输入层）', async () => {
    const w = await boundWorld(db(), 'f082-b24');
    const target = await w.numberField();
    for (const priority of [1_000_001, -1]) {
      const response = await save(w, [calcItem(target, '1', { priority })]);
      expect(response.status, String(priority)).toBe(400);
    }
    expect((await save(w, [calcItem(target, '1', { priority: 1_000_000 })])).status).toBe(201);
  });
});
