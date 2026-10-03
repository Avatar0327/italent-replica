/**
 * REQ-APV-004 / DEC-036：单流程仿真与按对象仿真。虚拟数据，不生成实例、待办或消息；
 * 按对象仿真同时给出原站规则（按实体、跨审批类型按优先级）与复刻规则（DEC-017 先按类型过滤）的命中流程。
 */
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

describe('AC-APV-11 按对象仿真', () => {
  it('离职无条件流程与调动流程同时满足：列出两者核算结果，原站会被离职接住，复刻只在调动类型内命中', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-object');
    const s = await transferScene(w);
    const leave = await w.publishedProcess({
      code: 'DimissionProcessNew',
      approvalType: 'leave',
      priority: -5,
      isFallback: true,
      conditions: { items: [] },
      nodes: [TRANSFER_NODES[0]!],
    });
    const transfer = await w.publishedProcess({ code: 'TransferStandard', priority: 0, nodes: TRANSFER_NODES });
    const before = await sideEffects(w);
    const result = await w.json<{
      replica: { processId: string } | null;
      originalSite: { processId: string; approvalType: string } | null;
      processes: {
        processId: string;
        approvalType: string;
        matched: boolean;
        items: { no: number; result: boolean }[];
      }[];
    }>(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: {
          approvalType: 'transfer',
          scope: 'published',
          data: {
            values: { processCode: 'TransferProcessNew', 'before.departmentId': s.from, 'record.departmentId': s.to },
            subjectEmployeeId: s.subject.employeeId,
          },
        },
      }),
    );
    expect(result.processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ processId: leave.id, approvalType: 'leave', matched: true }),
        expect.objectContaining({
          processId: transfer.id,
          approvalType: 'transfer',
          matched: true,
          items: [expect.objectContaining({ no: 1, result: true })],
        }),
      ]),
    );
    expect(result.originalSite).toMatchObject({ processId: leave.id, approvalType: 'leave' });
    expect(result.replica).toMatchObject({ processId: transfer.id });
    expect(await sideEffects(w)).toEqual(before);
  });

  it('复刻规则下同类型都不满足时给出报错原因', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-none');
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const result = await w.json<{ replica: unknown; replicaError: string }>(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: { approvalType: 'transfer', scope: 'published', data: { values: { processCode: 'Other' } } },
      }),
    );
    expect(result).toMatchObject({ replica: null, replicaError: '没有可用的调动流程' });
  });
});

describe('AC-APV-12 单流程仿真', () => {
  it('某节点审批人为空：标为异常并写原因；首节点为空提示提交将报错；不产生待办与消息', async () => {
    const w = await approvalWorld(database().db, 'apv-sim-single');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    const draft = await w.createProcess({ nodes: TRANSFER_NODES });
    const before = await sideEffects(w);
    const result = await w.json<{
      startable: boolean;
      conditions: { result: boolean };
      nodes: { key: string; status: string; approverUserId: string | null; resolution: string; message: string }[];
    }>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
        body: {
          scope: 'latest',
          data: {
            values: { processCode: 'TransferProcessNew', 'before.departmentId': s.from, 'record.departmentId': s.to },
            subjectEmployeeId: s.subject.employeeId,
          },
        },
      }),
    );
    expect(result.conditions.result).toBe(true);
    expect(result.startable).toBe(true);
    expect(result.nodes).toEqual([
      expect.objectContaining({ key: 'out_head', status: 'pass', approverUserId: s.outHead.userId }),
      expect.objectContaining({
        key: 'in_hrbp',
        status: 'exception',
        approverUserId: w.exceptionAdmin,
        resolution: 'exception_admin',
        message: expect.stringContaining('审批人为空'),
      }),
      expect.objectContaining({ key: 'in_head', status: 'pass', approverUserId: s.inHead.userId }),
      expect.objectContaining({ key: 'first_level', status: 'pass', approverUserId: s.inHead.userId }),
    ]);
    const firstEmpty = await w.json<{ startable: boolean; nodes: { status: string; resolution: string }[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
        body: { scope: 'latest', data: { values: { processCode: 'TransferProcessNew', 'record.departmentId': s.to } } },
      }),
    );
    expect(firstEmpty.startable).toBe(false);
    expect(firstEmpty.nodes[0]).toMatchObject({ status: 'exception', resolution: 'first_node_empty' });
    expect(await sideEffects(w)).toEqual(before);
  });
});
