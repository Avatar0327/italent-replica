/**
 * REQ-APV-004 / DEC-036：单流程仿真与按对象仿真，只用虚拟数据——审批人关系、组织上下级都由仿真输入给出，
 * 不读取真实人员、组织负责人或账号绑定（PR #35 第二轮清单 7）；不生成实例、待办或消息。
 * 按对象仿真同时给出原站规则与复刻规则的命中流程，并继续核算命中流程能否提交（X-17）；输入格式错误返回 400（X-18）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

async function sideEffects(w: Awaited<ReturnType<typeof approvalWorld>>) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT
      (SELECT count(*) FROM approval_instances)::int AS instances,
      (SELECT count(*) FROM approval_tasks)::int AS tasks,
      (SELECT count(*) FROM approval_notifications)::int AS notifications,
      (SELECT count(*) FROM approval_outbox)::int AS outbox`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
  });
}

interface SimNode {
  key: string;
  status: string;
  approverUserId: string | null;
  resolution: string;
  message: string;
}

describe('AC-APV-11 按对象仿真', () => {
  it('离职无条件流程与调动流程同时满足：列出两者核算结果，原站会被离职接住，复刻只在调动类型内命中', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-object');
    const leave = await w.publishedProcess({
      code: 'DimissionProcessNew',
      approvalType: 'leave',
      priority: -5,
      isFallback: true,
      conditions: { items: [] },
      nodes: [TRANSFER_NODES[0]!],
    });
    const transfer = await w.publishedProcess({ code: 'TransferStandard', priority: 0, nodes: TRANSFER_NODES });
    const head = randomUUID();
    const before = await sideEffects(w);
    const result = await w.json<{
      replica: { processId: string } | null;
      replicaStartable: boolean;
      originalSite: { processId: string; approvalType: string } | null;
      processes: { processId: string; approvalType: string; matched: boolean }[];
    }>(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: {
          approvalType: 'transfer',
          scope: 'published',
          data: { values: { processCode: 'TransferProcessNew' }, relations: { latest_record_department_head: head } },
        },
      }),
    );
    expect(result.processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ processId: leave.id, approvalType: 'leave', matched: true }),
        expect.objectContaining({ processId: transfer.id, approvalType: 'transfer', matched: true }),
      ]),
    );
    expect(result.originalSite).toMatchObject({ processId: leave.id, approvalType: 'leave' });
    expect(result.replica).toMatchObject({ processId: transfer.id });
    expect(result.replicaStartable).toBe(true);
    expect(await sideEffects(w)).toEqual(before);
  });

  it('复刻规则下同类型都不满足时给出报错原因；命中但首节点为空时提示提交将失败（X-17）', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-none');
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const none = await w.json<{ replica: unknown; replicaError: string }>(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: { approvalType: 'transfer', scope: 'published', data: { values: { processCode: 'Other' } } },
      }),
    );
    expect(none).toMatchObject({ replica: null, replicaError: '没有可用的调动流程' });
    const empty = await w.json<{ replica: unknown; replicaStartable: boolean; replicaError: string }>(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: { approvalType: 'transfer', scope: 'published', data: { values: { processCode: 'TransferProcessNew' } } },
      }),
    );
    expect(empty.replica).not.toBeNull();
    expect(empty.replicaStartable).toBe(false);
    expect(empty.replicaError).toContain('第一个审批节点没有审批人');
  });
});

describe('AC-APV-12 单流程仿真', () => {
  it('审批人来自虚拟关系；某节点为空标为异常；首节点为空提示提交将报错；不产生待办与消息', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-single');
    const draft = await w.createProcess({ nodes: TRANSFER_NODES });
    const [head, inHead, firstLevel] = [randomUUID(), randomUUID(), randomUUID()];
    const before = await sideEffects(w);
    const simulate = async (data: object) =>
      w.json<{ startable: boolean; conditions: { result: boolean }; nodes: SimNode[] }>(
        await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, { body: { scope: 'latest', data } }),
      );
    const result = await simulate({
      values: { processCode: 'TransferProcessNew' },
      relations: {
        latest_record_department_head: head,
        record_department_hrbp: null,
        record_department_head: inHead,
        record_first_level_org_head: firstLevel,
      },
    });
    expect(result.conditions.result).toBe(true);
    expect(result.startable).toBe(true);
    expect(result.nodes).toEqual([
      expect.objectContaining({ key: 'out_head', status: 'pass', approverUserId: head }),
      expect.objectContaining({
        key: 'in_hrbp',
        status: 'exception',
        approverUserId: w.exceptionAdmin,
        resolution: 'exception_admin',
        message: expect.stringContaining('审批人为空'),
      }),
      expect.objectContaining({ key: 'in_head', status: 'pass', approverUserId: inHead }),
      expect.objectContaining({ key: 'first_level', status: 'pass', approverUserId: firstLevel }),
    ]);
    const firstEmpty = await simulate({ values: { processCode: 'TransferProcessNew' } });
    expect(firstEmpty.startable).toBe(false);
    expect(firstEmpty.nodes[0]).toMatchObject({ status: 'exception', resolution: 'first_node_empty' });
    expect(await sideEffects(w)).toEqual(before);
  });

  it('清单 7：只有仿真权限的人传入真实部门 / 员工标识，也拿不到真实负责人或账号', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-leak');
    const s = await transferScene(w);
    const draft = await w.createProcess({ nodes: TRANSFER_NODES });
    const result = await w.json<{ nodes: SimNode[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
        body: {
          scope: 'latest',
          data: {
            values: { processCode: 'TransferProcessNew', 'before.departmentId': s.from, 'record.departmentId': s.to },
          },
        },
      }),
    );
    const real = [s.outHead.userId, s.inHead.userId, s.inHrbp.userId, s.subject.userId];
    expect(result.nodes.map((node) => node.approverUserId).filter((id) => id && real.includes(id))).toEqual([]);
    expect(result.nodes[0]).toMatchObject({ resolution: 'first_node_empty' });
  });

  it('X-18：组织、引用、日期输入格式错误返回 400 与机器可读字段', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-input');
    const draft = await w.createProcess({ nodes: TRANSFER_NODES });
    for (const values of [
      { 'before.departmentId': '测试部门' },
      { 'record.levelId': 'L9' },
      { 'record.effectiveDate': '2026-13-01' },
    ]) {
      const response = await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
        body: { scope: 'latest', data: { values } },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { details: { reason: string; field: string } } };
      expect(body.error.details).toMatchObject({ reason: 'APPROVAL_SIMULATION_INPUT', field: Object.keys(values)[0] });
    }
  });
});
