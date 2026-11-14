/**
 * AC-APV-F326-14（F-326 S5，设计 §5.3）：`source-candidates` 三类新来源（公共变量 / 应用变量 / 矩阵）与 `ids` 回查。
 * 全部经真实 HTTP（createApp）调用；候选只返回 {id,name,enabled,parentId}，变量与矩阵列另带 multiple，不含人员。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL,
  matrix,
  matrixStatus,
  references,
  s4World,
  variable,
  variableCommand,
  type S4World,
} from './AC-APV-F326-S4-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const PATH = `${APPROVAL}/designer/source-candidates`;
const ASOF = 'asOf=2026-10-01';

interface Candidate {
  id: string;
  name: string;
  enabled: boolean;
  parentId: string | null;
  multiple?: boolean;
}
const page = (w: S4World, query: string, allow = true) =>
  tenantApi(w.db, { authorize: (q) => allow && q.action === 'admin.process_matrix', clock: w.clock }).request(
    'GET',
    `${PATH}?${query}`,
    w.as(w.hr.id),
  );
const items = async (w: S4World, query: string) => {
  const response = await page(w, query);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Candidate[] }).items;
};
async function disable(w: S4World, v: { id: string; revision: number }) {
  const { total } = await references(w, 'variables', v.id);
  const response = await variableCommand(w, v, 'disable', { acknowledgedReferenceCount: total });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('AC-APV-F326-14 候选接口：三类来源与 ids 回查', () => {
  it('公共变量：只给启用且适用于流程的人员 / 多人变量，名称带编码；停用、草稿、非人员类型不出现', async () => {
    const w = await s4World(database().db, 'cand-public');
    const one = await variable(w, { name: '合成单人变量' });
    const many = await variable(w, { name: '合成多人变量', dataType: 'persons', defaultValue: [w.near.userId] });
    await variable(w, { dataType: 'string', defaultValue: '文本' });
    await variable(w, { name: '合成草稿变量', enable: false });
    await variable(w, { name: '合成非流程变量', usageScopes: ['business_rule'] });
    const stopped = await variable(w, { name: '合成停用变量' });
    await disable(w, stopped);
    const found = await items(w, `type=public_variable&${ASOF}`);
    expect(found.map((item) => item.id).sort()).toEqual([one.id, many.id].sort());
    const byId = new Map(found.map((item) => [item.id, item]));
    expect(byId.get(one.id)).toEqual({
      id: one.id,
      name: `合成单人变量（${one.code}）`,
      enabled: true,
      parentId: null,
      multiple: false,
    });
    expect(byId.get(many.id)?.multiple).toBe(true);
  });

  it('ids 回查带上停用、草稿与不适用于流程的项（enabled=false），且不泄露人员默认值', async () => {
    const w = await s4World(database().db, 'cand-ids');
    const stopped = await variable(w, { name: '合成停用变量' });
    await disable(w, stopped);
    const draft = await variable(w, { name: '合成草稿变量', enable: false });
    const other = await variable(w, { name: '合成非流程变量', usageScopes: ['business_rule'] });
    const ids = [stopped.id, draft.id, other.id];
    expect(await items(w, `type=public_variable&${ASOF}&ids=${ids.join(',')}`)).toEqual([]);
    const found = await items(w, `type=public_variable&${ASOF}&includeInactive=true&ids=${ids.join(',')}`);
    expect(found.map((item) => item.id).sort()).toEqual([...ids].sort());
    expect(found.every((item) => !item.enabled)).toBe(true);
    expect(JSON.stringify(found)).not.toContain(w.near.userId);
  });

  it('应用变量：必须带 approvalType，只给该类型所属应用的变量；ids 回查含停用项', async () => {
    const w = await s4World(database().db, 'cand-app');
    const transfer = await variable(w, { scope: 'application', appId: 'transfer', name: '合成调动变量' });
    await variable(w, { scope: 'application', appId: 'staff', name: '合成人员变量' });
    await variable(w, { name: '合成公共变量' });
    expect((await page(w, `type=application_variable&${ASOF}`)).status).toBe(400);
    const found = await items(w, `type=application_variable&approvalType=transfer&${ASOF}`);
    expect(found).toEqual([
      { id: transfer.id, name: `合成调动变量（${transfer.code}）`, enabled: true, parentId: null, multiple: false },
    ]);
    await disable(w, transfer);
    expect(await items(w, `type=application_variable&approvalType=transfer&${ASOF}`)).toEqual([]);
    const back = await items(
      w,
      `type=application_variable&approvalType=transfer&${ASOF}&includeInactive=true&ids=${transfer.id}`,
    );
    expect(back).toMatchObject([{ id: transfer.id, enabled: false }]);
  });

  it('矩阵：表头一级（parentId=null），角色列二级（id=矩阵:列、parentId=矩阵）；条件列不出现；ids 回查含停用矩阵', async () => {
    const w = await s4World(database().db, 'cand-matrix');
    const m = await matrix(w, { rows: [{ cond: [], role: [w.head.userId] }], allowMultiple: true });
    const found = await items(w, `type=matrix&${ASOF}`);
    expect(found).toEqual(
      expect.arrayContaining([
        { id: m.id, name: '合成矩阵', enabled: true, parentId: null },
        { id: `${m.id}:${m.roleId}`, name: '角色', enabled: true, parentId: m.id, multiple: true },
      ]),
    );
    expect(found.some((item) => item.id.endsWith(m.conditionId))).toBe(false);
    expect(JSON.stringify(found)).not.toContain(w.head.userId);

    expect((await matrixStatus(w, m, 'disable', { acknowledgedReferenceCount: 0 })).status).toBe(200);
    expect(await items(w, `type=matrix&${ASOF}`)).toEqual([]);
    const back = await items(w, `type=matrix&${ASOF}&includeInactive=true&ids=${m.id},${m.id}:${m.roleId}`);
    expect(back.map((item) => [item.id, item.enabled])).toEqual(
      expect.arrayContaining([
        [m.id, false],
        [`${m.id}:${m.roleId}`, false],
      ]),
    );
  });

  it('权限与跨租户：非流程管理员 403；别的租户的变量 / 矩阵 id 不回显；组合 id 只属于矩阵', async () => {
    const w = await s4World(database().db, 'cand-deny');
    const other = await s4World(database().db, 'cand-deny-other');
    const mine = await variable(w);
    const foreign = await variable(other);
    const foreignMatrix = await matrix(other, { rows: [{ cond: [], role: [other.head.userId] }] });
    expect((await page(w, `type=public_variable&${ASOF}`, false)).status).toBe(403);
    expect((await page(w, `type=matrix&${ASOF}`, false)).status).toBe(403);
    const base = `${ASOF}&includeInactive=true`;
    expect(await items(w, `type=public_variable&${base}&ids=${mine.id},${foreign.id}`)).toMatchObject([
      { id: mine.id },
    ]);
    expect(await items(w, `type=matrix&${base}&ids=${foreignMatrix.id}`)).toEqual([]);
    expect((await page(w, `type=public_variable&${base}&ids=${mine.id}:${mine.id}`)).status).toBe(400);
    expect((await page(w, `type=matrix&${base}&ids=${mine.id}:${mine.id}:${mine.id}`)).status).toBe(400);
  });
});
