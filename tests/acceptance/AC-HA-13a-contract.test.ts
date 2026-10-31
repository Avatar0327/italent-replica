/**
 * BE-13a / AC-HA-13a-07～09：合同情况看板（B55，规格 35“补充：BE-13…”）。
 * 固定夹具（asOf = 租户今天 2026-10-01，变动日期默认 2026 全年）：
 * - 变动计数按已生效的初签 / 变更 / 续签 / 终止申请单（更正与在途单不计），日期取生效日（终止取实际终止日）；
 * - 签署情况 = asOf 当天在职且有有效合同的员工（🟡 推测口径），按法人前 10（带占比）/ 合同类型 / 期限类型；
 * - 3.1.17 复用人事看板 contractExpiring30 的同一谓词，再套看板筛选。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  boardClient,
  CONTRACT_BOARD_BASE,
  contractKit,
  sorted,
  structureWorld,
  type BoardClient,
} from './AC-HA-13a-support.js';

const database = useTestDb();
const B = CONTRACT_BOARD_BASE;
const AS_OF = 'asOf=2026-10-01';

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha13a-contract');
  const k = await contractKit(w);
  const department = await w.org('合同部门');
  const x = await k.master('companies', '合成法人甲');
  const y = await k.master('companies', '合成法人乙');
  const labor = await k.master('types', '劳动合同');
  const service = await k.master('types', '劳务合同');
  const person = (name: string) => w.hire(name, { date: '2020-01-01', department });
  const fixed = (typeId: string, companyId: string, effectiveDate: string, endDate: string) => ({
    typeId,
    companyId,
    effectiveDate,
    endDate,
    termType: 'fixed',
    signingDate: effectiveDate,
  });

  const p = {
    renewed: await person('合同续签'),
    changed: await person('合同变更'),
    terminated: await person('合同终止'),
    expiring: await person('合同即将到期'),
    indefinite: await person('合同无固定期限'),
    none: await person('没有合同'),
  };
  // 2024 年初签、2026-01-01 续签（续签计入 2026，初签不计）
  const old = await k.command({
    operation: 'create',
    employeeId: p.renewed.id,
    fields: fixed(labor.id, x.id, '2024-01-01', '2025-12-31'),
  });
  const renewal = await k.command(
    {
      operation: 'renew',
      employeeId: p.renewed.id,
      targetId: old.id,
      fields: { effectiveDate: '2026-01-01', endDate: '2028-12-31', termType: 'fixed' },
    },
    old.revision,
  );
  // 2026 初签、2026-06-01 变更（法人乙）
  const first = await k.command({
    operation: 'create',
    employeeId: p.changed.id,
    fields: fixed(labor.id, y.id, '2026-02-01', '2027-01-31'),
  });
  const changed = await k.command(
    {
      operation: 'change',
      employeeId: p.changed.id,
      targetId: first.id,
      fields: { effectiveDate: '2026-06-01', endDate: '2028-01-31' },
    },
    first.revision,
  );
  // 2026 初签劳务合同（法人乙），2026-08-31 终止：签署情况不计
  const ended = await k.command({
    operation: 'create',
    employeeId: p.terminated.id,
    fields: fixed(service.id, y.id, '2026-03-01', '2027-02-28'),
  });
  await k.command(
    {
      operation: 'terminate',
      employeeId: p.terminated.id,
      targetId: ended.id,
      fields: { actualTerminationDate: '2026-08-31' },
    },
    ended.revision,
  );
  // 2026-10-20 到期：3.1.17 计入
  const expiring = await k.command({
    operation: 'create',
    employeeId: p.expiring.id,
    fields: fixed(labor.id, x.id, '2026-09-01', '2026-10-20'),
  });
  const indefinite = await k.command({
    operation: 'create',
    employeeId: p.indefinite.id,
    fields: { typeId: labor.id, companyId: x.id, effectiveDate: '2024-03-01', termType: 'indefinite' },
  });
  // 反例：2026 年已生效的更正（edit）与审批中的初签都不是“变动”
  const correction = await k.rawRequest(p.indefinite.id, indefinite, {
    operation: 'edit',
    status: 'effective',
    typeId: labor.id,
    companyId: x.id,
    effectiveDate: '2026-05-01',
  });
  const inReview = await k.rawRequest(p.none.id, null, {
    operation: 'create',
    status: 'in_review',
    typeId: labor.id,
    companyId: x.id,
    effectiveDate: '2026-05-01',
  });

  const requests = {
    renew: await k.requestIds(p.renewed.id, 'renew'),
    createdOld: await k.requestIds(p.renewed.id, 'create'),
    createChanged: await k.requestIds(p.changed.id, 'create'),
    change: await k.requestIds(p.changed.id, 'change'),
    createTerminated: await k.requestIds(p.terminated.id, 'create'),
    terminate: await k.requestIds(p.terminated.id, 'terminate'),
    createExpiring: await k.requestIds(p.expiring.id, 'create'),
    createIndefinite: await k.requestIds(p.indefinite.id, 'create'),
  };
  const contracts = { renewal, changed, expiring, indefinite, old, ended };
  return { w, x, y, labor, service, p, contracts, requests, correction, inReview };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('AC-HA-13a B55 合同情况', () => {
  let x: World;
  let c: BoardClient;
  beforeAll(async () => {
    x = await buildWorld();
    c = boardClient(database().db, x.w.who);
  }, 300_000);

  it('AC-HA-13a-07：合同变动统计（初签 / 变更 / 续签 / 终止）默认今年；更正与在途申请不计；数字 = 明细（申请单）', async () => {
    const board = await c.board(B);
    expect(board.asOf).toBe('2026-10-01');
    expect(board.components.map((item) => item.code)).toEqual([
      'changeCreate',
      'changeChange',
      'changeRenew',
      'changeTerminate',
      'signByCompany',
      'signByType',
      'signByTermType',
      '3.1.17',
    ]);
    const r = x.requests;
    await c.expectCount(B, 'changeCreate', [...r.createChanged, ...r.createTerminated, ...r.createExpiring], AS_OF);
    await c.expectCount(B, 'changeChange', r.change, AS_OF);
    await c.expectCount(B, 'changeRenew', r.renew, AS_OF);
    await c.expectCount(B, 'changeTerminate', r.terminate, AS_OF);
    for (const code of ['changeCreate', 'changeChange']) {
      const seen = (await c.detail(B, code, AS_OF)).ids;
      expect(seen).not.toContain(x.correction);
      expect(seen).not.toContain(x.inReview);
    }
    // 变动日期区间：2024 年只有两张初签；终止按实际终止日落在 8 月
    await c.expectCount(
      B,
      'changeCreate',
      [...r.createdOld, ...r.createIndefinite],
      `${AS_OF}&changeFrom=2024-01-01&changeTo=2024-12-31`,
    );
    await c.expectCount(B, 'changeTerminate', r.terminate, `${AS_OF}&changeFrom=2026-08-31&changeTo=2026-08-31`);
    await c.expectCount(B, 'changeTerminate', [], `${AS_OF}&changeFrom=2026-03-01&changeTo=2026-08-30`);
  });

  it('AC-HA-13a-08：签署情况——asOf 当天在职且有有效合同；按法人（前 10、带占比）/ 合同类型 / 期限类型，数字 = 明细（合同）', async () => {
    const k = x.contracts;
    const signed = [k.renewal.id, k.changed.id, k.expiring.id, k.indefinite.id];
    const byCompany = (await c.component(B, 'signByCompany', AS_OF)).groups!;
    expect(byCompany.map((g) => [g.key, g.label, g.count, g.ratio])).toEqual([
      [x.x.id, '合成法人甲', 3, 0.75],
      [x.y.id, '合成法人乙', 1, 0.25],
    ]);
    await c.expectCount(B, 'signByCompany', [k.renewal.id, k.expiring.id, k.indefinite.id], AS_OF, x.x.id);
    await c.expectCount(B, 'signByCompany', [k.changed.id], AS_OF, x.y.id);
    await c.expectCount(B, 'signByType', signed, AS_OF, x.labor.id);
    await c.expectCount(B, 'signByType', [], AS_OF, x.service.id);
    await c.expectCount(B, 'signByTermType', [k.renewal.id, k.changed.id, k.expiring.id], AS_OF, 'fixed');
    await c.expectCount(B, 'signByTermType', [k.indefinite.id], AS_OF, 'indefinite');
    const terms = (await c.component(B, 'signByTermType', AS_OF)).groups!;
    expect(terms.map((g) => g.key)).toEqual(['fixed', 'indefinite', 'task', 'none']);
    // 已终止 / 已被续签或变更替换的旧合同不算；时点回到 2026-03-15：终止前的劳务合同仍有效
    const all = sorted((await c.detail(B, 'signByCompany', AS_OF, x.x.id)).ids);
    expect(all).not.toContain(k.old.id);
    await c.expectCount(B, 'signByType', [k.ended.id], 'asOf=2026-03-15', x.service.id);
  });

  it('AC-HA-13a-09：3.1.17 复用 contractExpiring30；看板筛选（公司 / 合同类型 / 期限类型）同时作用于数字与明细', async () => {
    const k = x.contracts;
    const r = x.requests;
    await c.expectCount(B, '3.1.17', [k.expiring.id], AS_OF);
    await c.expectCount(B, '3.1.17', [], `${AS_OF}&companyId=${x.y.id}`);
    // 2026-10-21 起已过期，不再是“未来 30 天到期”
    await c.expectCount(B, '3.1.17', [], 'asOf=2026-10-21');

    await c.expectCount(B, 'changeCreate', r.createExpiring, `${AS_OF}&companyId=${x.x.id}`);
    await c.expectCount(B, 'changeCreate', r.createTerminated, `${AS_OF}&typeId=${x.service.id}`);
    await c.expectCount(B, 'changeCreate', [], `${AS_OF}&termType=indefinite`);
    await c.expectCount(B, 'signByCompany', [k.indefinite.id], `${AS_OF}&termType=indefinite`, x.x.id);
    await c.expectCount(B, 'signByType', [k.changed.id], `${AS_OF}&companyId=${x.y.id}`, x.labor.id);
  });

  it('AC-HA-13a-09：参数校验——日期 / ID / 期限类型不合法 400，区间倒置 400，未知组件 404', async () => {
    for (const bad of [
      'asOf=2026-02-30',
      'changeFrom=2026-13-01',
      'changeFrom=2026-10-01&changeTo=2026-01-01',
      'companyId=bad',
      'typeId=1',
      'termType=forever',
    ])
      expect((await c.get(`${B}?${bad}`)).status, bad).toBe(400);
    expect((await c.get(`${B}/components/nope?${AS_OF}`)).status).toBe(404);
    expect((await c.get(`${B}/components/changeCreate?${AS_OF}&page=0`)).status).toBe(400);
  });
});
