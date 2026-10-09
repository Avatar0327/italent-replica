/**
 * F-003 / AC-APV-31：流程仿真支持会签节点（DEC-036；DEC-144）。只用虚拟数据：逐人给出审批人与处理方式、节点的
 * 流转规则；首节点会签任一审批人为空时与真实提交同一套预检，提示不可提交；不产生待办与消息。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, type NodeInput } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
  transitionRule: { type: 'all' },
};

interface SimSeat {
  expression: string;
  status: string;
  approverUserId: string | null;
  resolution: string;
}

interface SimResult {
  startable: boolean;
  blockers: string[];
  nodes: {
    key: string;
    kind: string;
    status: string;
    approverUserId: string | null;
    approvers?: SimSeat[];
    transitionRule?: { type: string };
  }[];
}

async function tasksAndNotices(w: Awaited<ReturnType<typeof approvalWorld>>) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT
      (SELECT count(*) FROM approval_tasks)::int AS tasks,
      (SELECT count(*) FROM approval_notifications)::int AS notifications`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
  });
}

describe('AC-APV-31 仿真支持会签节点', () => {
  it('逐人给出审批人与处理方式；首节点会签任一审批人为空时不可提交；不产生待办与消息', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-sim');
    const draft = await w.createProcess({ nodes: [JOINT, TRANSFER_NODES[0]!] });
    const [head, hrbp, outHead] = [randomUUID(), randomUUID(), randomUUID()];
    const before = await tasksAndNotices(w);
    const simulate = async (relations: object) =>
      w.json<SimResult>(
        await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
          body: { scope: 'latest', data: { values: { processCode: 'TransferProcessNew' }, relations } },
        }),
      );
    const full = await simulate({
      record_department_head: head,
      record_department_hrbp: hrbp,
      latest_record_department_head: outHead,
    });
    expect(full.startable).toBe(true);
    expect(full.nodes[0]).toMatchObject({
      key: 'joint',
      kind: 'countersign',
      status: 'pass',
      approverUserId: null,
      transitionRule: { type: 'all' },
      approvers: [
        expect.objectContaining({ expression: 'record_department_head', status: 'pass', approverUserId: head }),
        expect.objectContaining({ expression: 'record_department_hrbp', status: 'pass', approverUserId: hrbp }),
      ],
    });
    expect(full.nodes[1]).toMatchObject({ key: 'out_head', kind: 'single', approverUserId: outHead });
    const partial = await simulate({ record_department_head: head, latest_record_department_head: outHead });
    expect(partial.startable).toBe(false);
    expect(partial.blockers.join()).toContain('第一个审批节点没有审批人');
    expect(partial.nodes[0]).toMatchObject({ status: 'exception' });
    expect(partial.nodes[0]!.approvers![1]).toMatchObject({ resolution: 'first_node_empty', approverUserId: null });
    expect(await tasksAndNotices(w)).toEqual(before);
  });

  it('会签在中间节点：为空的那一位转异常管理员，相同审批人逐人自动同意', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-sim-middle');
    const draft = await w.createProcess({
      nodes: [
        TRANSFER_NODES[0]!,
        { ...JOINT, approvers: ['latest_record_department_head', 'record_department_hrbp'], sameAssigneeSkip: true },
      ],
    });
    const outHead = randomUUID();
    const result = await w.json<SimResult>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
        body: {
          scope: 'latest',
          data: {
            values: { processCode: 'TransferProcessNew' },
            relations: { latest_record_department_head: outHead },
          },
        },
      }),
    );
    expect(result.startable).toBe(true);
    expect(result.nodes[1]).toMatchObject({ key: 'joint', status: 'exception' });
    expect(result.nodes[1]!.approvers).toEqual([
      expect.objectContaining({ status: 'pass', approverUserId: outHead, resolution: 'same_skip' }),
      expect.objectContaining({ status: 'exception', approverUserId: w.exceptionAdmin, resolution: 'exception_admin' }),
    ]);
  });
});

describe('F-048 T10 仿真支持多主体回避（DEC-329①）', () => {
  const MULTI: NodeInput = { ...TRANSFER_NODES[0]!, actions: { avoidSelf: false, avoidSubjects: true } };

  it('subjectUserIds（虚拟，作为 U(S)）命中节点审批人 → 标「多主体回避跳过」，不产生待办与消息；未命中照常', async () => {
    const w = await approvalWorld(database().db, 'apv-multi-sim');
    const draft = await w.createProcess({ nodes: [MULTI, TRANSFER_NODES[1]!] });
    const [outHead, hrbp, other] = [randomUUID(), randomUUID(), randomUUID()];
    const before = await tasksAndNotices(w);
    const simulate = async (subjectUserIds: string[]) =>
      w.json<SimResult>(
        await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
          body: {
            scope: 'latest',
            data: {
              values: { processCode: 'TransferProcessNew' },
              relations: { latest_record_department_head: outHead, record_department_hrbp: hrbp },
              subjectUserIds,
            },
          },
        }),
      );
    const hit = await simulate([outHead.toUpperCase(), other]);
    expect(hit.nodes[0]).toMatchObject({ key: 'out_head', status: 'pass', approverUserId: null });
    expect(hit.nodes[0]).toMatchObject({ resolution: 'subject_skip' });
    expect(hit.nodes[1]).toMatchObject({ resolution: 'resolved', approverUserId: hrbp });
    const miss = await simulate([other]);
    expect(miss.nodes[0]).toMatchObject({ resolution: 'resolved', approverUserId: outHead });
    expect(await tasksAndNotices(w)).toEqual(before);
  });

  it('subjectUserIds 超过 50 个或格式不合法 → 400', async () => {
    const w = await approvalWorld(database().db, 'apv-multi-sim-invalid');
    const draft = await w.createProcess({ nodes: [MULTI] });
    for (const subjectUserIds of [Array.from({ length: 51 }, () => randomUUID()), ['not-a-uuid']]) {
      const response = await w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/simulate`, {
        body: { scope: 'latest', data: { values: { processCode: 'TransferProcessNew' }, subjectUserIds } },
      });
      expect(response.status).toBe(400);
    }
  });
});
