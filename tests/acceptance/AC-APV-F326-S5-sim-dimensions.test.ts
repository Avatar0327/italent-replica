/**
 * AC-APV-F326-16（F-326 S5 第 2 轮，设计 §3.7 / §2.1）：模拟当前值路径下，矩阵条件列的部门 / 职位 / 职务取虚拟输入，
 * 所有能配置矩阵来源的审批类型都得能给出这三个虚拟值（不再受各类型发起条件字段白名单限制）。
 * 只给虚拟值，不读真实任职；全部经真实 HTTP（createApp），两条模拟路由都覆盖。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { APPROVAL, counter, matrix, matrixSource, s4World } from './AC-APV-F326-S4-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

type Dimension = 'position' | 'job';
const PATH: Record<Dimension, string> = { position: 'record.positionId', job: 'record.postId' };

async function scene(label: string, approvalType: string, dimension: Dimension) {
  const w = await s4World(database().db, label);
  const hit = randomUUID();
  const m = await matrix(w, {
    dimension,
    rows: [
      { cond: [hit], role: [w.head.userId] },
      { cond: [randomUUID()], role: [w.near.userId] },
    ],
  });
  const process = await w.publishedProcess({
    approvalType,
    isFallback: true,
    conditions: { items: [] },
    nodes: [counter([matrixSource(m, m.roleId)])],
  });
  const api = tenantApi(w.db, { authorize: () => true, clock: w.clock });
  const simulate = (values: Record<string, string | null>, byObject: boolean) =>
    api.request('POST', byObject ? `${APPROVAL}/simulate` : `${APPROVAL}/processes/${process.id}/simulate`, {
      ...w.as(w.hr.id),
      body: {
        ...(byObject ? { approvalType } : {}),
        scope: 'published',
        data: { values },
        resolveCurrentSources: true,
      },
    });
  return { w, hit, simulate, headUser: w.head.userId };
}

const seats = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { nodes: { approvers?: { approverUserId: string | null }[] }[] };
  return body.nodes[0]!.approvers!.map((seat) => seat.approverUserId);
};

describe('AC-APV-F326-16 模拟当前值路径：矩阵职位 / 职务虚拟值对各审批类型可用', () => {
  const cases = ['part_time_add', 'personnel_change'].flatMap((type) =>
    (['position', 'job'] as const).flatMap((dimension) =>
      [false, true].map((byObject) => ({ type, dimension, byObject })),
    ),
  );

  it.each(cases)('命中：$type · $dimension 条件给命中值 → 取矩阵命中行的人（按对象 $byObject）', async (c) => {
    const s = await scene(`dim-hit-${c.type}-${c.dimension}-${c.byObject}`, c.type, c.dimension);
    const response = await s.simulate({ [PATH[c.dimension]]: s.hit }, c.byObject);
    if (!c.byObject) return expect(await seats(response)).toEqual([s.headUser]);
    // 按对象的响应只给“能否提交”：命中行有人 → 预检通过（具体是谁由按流程那一路的用例锁定）
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replicaStartable: true, replicaError: null });
  });

  it.each(cases)('未命中：$type · $dimension 条件给不在矩阵里的值 → 审批人为空（按对象 $byObject）', async (c) => {
    const s = await scene(`dim-miss-${c.type}-${c.dimension}-${c.byObject}`, c.type, c.dimension);
    const response = await s.simulate({ [PATH[c.dimension]]: randomUUID() }, c.byObject);
    if (!c.byObject) return expect(await seats(response)).toEqual([null]);
    // 按对象：矩阵没命中 → 首节点无人，预检判不可提交（不是 400，也不是命中了别的行）
    expect(response.status).toBe(200);
    const body = (await response.json()) as { replicaStartable: boolean; replicaError?: string };
    expect(body).toMatchObject({ replicaStartable: false, replicaError: '第一个审批节点没有审批人' });
  });

  it('不放宽无关输入校验：仍拒绝未知路径与非 UUID 的职位值', async () => {
    const s = await scene('dim-guard', 'part_time_add', 'position');
    const bad: Record<string, string>[] = [{ 'record.nonsense': randomUUID() }, { 'record.positionId': 'not-a-uuid' }];
    for (const values of bad) {
      const response = await s.simulate(values, false);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { details: { reason?: string } } }).error.details.reason).toBe(
        'APPROVAL_SIMULATION_INPUT',
      );
    }
  });
});
