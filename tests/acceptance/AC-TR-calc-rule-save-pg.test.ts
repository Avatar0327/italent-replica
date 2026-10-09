/**
 * AC-TR-calc-rule-save-pg · R3-T04 PR-B5 计算规则的真 PostgreSQL 并发（设计 §9；AGENTS §10 并发）：
 * 同一规则同一 revision 的并发修改恰好一个成功，revision 只加 1；同名规则并发新建恰好一个成功，库里只留一条。
 * PGlite 单连接无法并发，仅在设置 TEST_DATABASE_URL 时运行。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { CALC_RULES, calcBody, calcItem, calcWorld } from './AC-TR-calc-rule-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('计算规则 · PostgreSQL 16 并发', () => {
  it('同一 revision 并发修改 items：一个 200，一个 409，revision 只加 1，items 是胜者的', async () => {
    const w = await calcWorld(testDb().db, 'trk-pg-revision');
    const a = await w.numberField();
    const created = await w.create(calcBody([calcItem(a, '1')]));
    const patch = (formula: string) =>
      w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 1, body: { items: [calcItem(a, formula)] } });
    const responses = await Promise.all([patch('10'), patch('20')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const now = (await w.read(created.id)).body;
    expect(now.revision).toBe(2);
    expect(now.items).toHaveLength(1);
  });

  it('同名规则并发新建：恰好一个 201，另一个 409，库里只有一条', async () => {
    const w = await calcWorld(testDb().db, 'trk-pg-name');
    const a = await w.numberField();
    const body = calcBody([calcItem(a, '1')], { name: '并发同名' });
    const responses = await Promise.all([w.post(body), w.post(body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await w.list()).items).toHaveLength(1);
  });
});
