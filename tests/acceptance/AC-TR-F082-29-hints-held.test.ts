/**
 * F-082 #224 第 1 轮 P2-2：保存 / 启用提示（hints）不因“合法保留的停用引用”或“尚未改绑的项目”而丢失循环诊断（DEC-274）。
 * - bound：互相引用的 A、B 首次保存收到循环提示；停用 A 后原样保存（已有引用允许保留，契约 §3.3）、重放、启用规则，
 *   循环 / 阻塞列表仍在，不退化成泛化提示；
 * - legacy（B5 写入、开关打开后启用）：仍按名称检测出循环；
 * - unresolved / legacy 与 bound 混合：不做不完整的检测，明确提示“无法完整校验”，不返回全空的 hints。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { CALC_RULES, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import {
  boundWorld,
  calcBody,
  calcItem,
  catalogVersion,
  f082World,
  fieldRevision,
  itemIdOf,
  setBinding,
} from './AC-TR-F082-support.js';
import { tenantApi } from './support/tenant-api.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';

const testDb = useTestDb();
const db = () => testDb().db;

describe('bound：合法保留停用引用时循环诊断不丢', () => {
  it('A↔B 互相引用：停用 A 后原样保存 / 重放 / 启用，hints.cycles 与 blocked 仍在', async () => {
    const w = await boundWorld(db(), 'f082-p22a');
    const [a, b] = [await w.field('number', { name: '甲' }), await w.field('number', { name: '乙' })];
    const items = [calcItem(a, '盘点对象.乙 + 1'), calcItem(b, '盘点对象.甲 + 1')];
    const first = await w.post(calcBody(items, { fieldCatalogVersion: await catalogVersion(db(), w) }));
    expect(first.status, await first.clone().text()).toBe(201);
    const rule = (await first.json()) as CalcRuleView;
    expect(rule.hints?.cycles.length).toBeGreaterThan(0);
    expect(rule.hints?.blocked.sort()).toEqual([a.id, b.id].sort());

    // 停用 A：它是已有引用也是已有目标，保存时允许保留
    const off = await w.request('PATCH', `/fields/${a.id}`, {
      ifMatch: await fieldRevision(w, a.id),
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    const read = await w.read(rule.id);
    const resubmit = [
      calcItem(a, '盘点对象.乙 + 1', { formulaBindings: [b.id] }),
      calcItem(b, '盘点对象.甲 + 1', { formulaBindings: [a.id] }),
    ];
    const key = 'f082-p22a-key';
    const save = await w.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: read.body.revision,
      body: { items: resubmit },
      idempotencyKey: key,
    });
    expect(save.status, await save.clone().text()).toBe(200);
    const saved = (await save.json()) as CalcRuleView;
    expect(saved.hints?.cycles.length).toBeGreaterThan(0);
    expect(saved.hints?.blocked.sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(saved.hints?.warnings)).not.toContain('无法完整校验');

    // 重放：同样的提示
    const replay = await w.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: read.body.revision,
      body: { items: resubmit },
      idempotencyKey: key,
    });
    expect(((await replay.json()) as CalcRuleView).hints?.cycles.length).toBeGreaterThan(0);

    // 启用规则：循环提示仍在
    const enable = await w.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: saved.revision,
      body: { enabled: true },
    });
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as CalcRuleView;
    expect(enabled.hints?.cycles.length).toBeGreaterThan(0);
    expect(enabled.hints?.blocked.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('legacy / unresolved：不返回全空的 hints', () => {
  it('B5 写入的循环规则（legacy）在开关打开后启用：仍检测出循环', async () => {
    const off = await f082World(db(), 'f082-p22b');
    const [a, b] = [await off.field('number', { name: '丙' }), await off.field('number', { name: '丁' })];
    const rule = await off.create(calcBody([calcItem(a, '盘点对象.丁 + 1'), calcItem(b, '盘点对象.丙 + 1')]));
    const on = tenantApi(db(), { clock: () => TR_NOW, formulaIdBinding: true });
    const enable = await on.request('PATCH', `${TR_BASE}${CALC_RULES}/${rule.id}`, {
      ...off.as,
      ifMatch: rule.revision,
      body: { enabled: true },
    });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const view = (await enable.json()) as CalcRuleView;
    expect(view.hints?.cycles.length).toBeGreaterThan(0);
    expect(view.hints?.blocked.length).toBeGreaterThan(0);
  });

  it('unresolved 与 legacy 混合：明确提示“无法完整校验”，order 仍列出全部目标，不是四项全空', async () => {
    const off = await f082World(db(), 'f082-p22c');
    const [a, b] = [await off.field('number', { name: '戊' }), await off.field('number', { name: '己' })];
    const rule = await off.create(calcBody([calcItem(a, '盘点对象.己 + 1'), calcItem(b, '1')]));
    await setBinding(db(), off, await itemIdOf(db(), off, rule.id, a.id), 'unresolved', 'INVALID');
    const on = tenantApi(db(), { clock: () => TR_NOW, formulaIdBinding: true });
    const enable = await on.request('PATCH', `${TR_BASE}${CALC_RULES}/${rule.id}`, {
      ...off.as,
      ifMatch: rule.revision,
      body: { enabled: true },
    });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const view = (await enable.json()) as CalcRuleView;
    expect(view.hints?.warnings.join('|')).toContain('无法完整校验');
    expect([...(view.hints?.order ?? [])].sort()).toEqual([a.id, b.id].sort());
  });
});
