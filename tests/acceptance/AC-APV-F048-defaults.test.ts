/**
 * F-048 PR-1 开关的输入 / 存储 / 回显与缺省值（docs/08_设计/F-048_审批多主体回避_设计.md §3，测试 T11）：
 * - DEC-329④：管理员新建节点不给开关即关闭；草稿整份替换漏传时沿用该节点当前值；新版本复制；回显始终显式；
 * - 存量节点保持冻结的列值；DEC-332①：预置按业务敏感度显式取值（非 IDP true、IDP false），全部预置 avoidSubjects false；
 * - R3-01：PR-1 阶段保存 / 草稿 / 发布都拒绝 avoidSubjects=true；DEC-331⑤：命中动作只启用「跳过」。
 */
import { sql } from '@italent/db';
import { APPROVAL_TYPES, PRESET_PROCESSES, type ApprovalTypeCode } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

interface NodeView {
  key: string;
  actions: { avoidSelf?: boolean; avoidSubjects?: boolean };
  avoidSubjectsResult?: string;
}
interface Process {
  id: string;
  revision: number;
  approvalType: string;
  latestVersion: { status: string; nodes: NodeView[] };
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}

function body(type: ApprovalTypeCode, nodes: Record<string, unknown>[], code = `F048_${type}_${Date.now()}`) {
  return {
    code: code.slice(0, 60),
    name: `F-048 ${APPROVAL_TYPES[type].name}`,
    approvalType: type,
    exceptionAdminUserId: null,
    conditions: { items: [] },
    nodes,
  };
}

async function createRaw(w: ApprovalWorld, type: ApprovalTypeCode, nodes: Record<string, unknown>[]) {
  return w.request(w.hr.id, 'POST', `${BASE}/processes`, { ifMatch: 0, body: body(type, nodes) });
}

async function getProcess(w: ApprovalWorld, id: string): Promise<Process> {
  return w.json<Process>(await w.request(w.hr.id, 'GET', `${BASE}/processes/${id}`));
}

const nodeOf = (process: Process, key: string) => process.latestVersion.nodes.find((node) => node.key === key)!;

describe('T11 新建节点缺省关闭、回显显式（DEC-329④）', () => {
  const types: ApprovalTypeCode[] = ['transfer', 'leave', 'personnel_change', 'contract_create', 'idp_plan'];
  for (const type of types) {
    it(`${APPROVAL_TYPES[type].name}：不传开关 → avoidSelf / avoidSubjects 均为 false，命中动作为「跳过」`, async () => {
      const w = await approvalWorld(database().db, `f048-default-${type}`);
      const created = await w.json<Process>(await createRaw(w, type, [{ key: 'n1', approver: 'owner' }]), 201);
      expect(nodeOf(created, 'n1')).toMatchObject({
        actions: { avoidSelf: false, avoidSubjects: false },
        avoidSubjectsResult: 'skip',
      });
      expect(nodeOf(await getProcess(w, created.id), 'n1').actions).toMatchObject({
        avoidSelf: false,
        avoidSubjects: false,
      });
    });
  }

  it('调动：手工新建且不传开关的流程，发起人自己就是审批人时正常收到待办（不再自审回避）', async () => {
    const w = await approvalWorld(database().db, 'f048-default-runtime');
    const s = await transferScene(w);
    await w.publish(
      (await w.json<Process>(
        await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
          ifMatch: 0,
          body: {
            ...body('transfer', [{ key: 'owner_node', approver: 'owner' }]),
            exceptionAdminUserId: w.exceptionAdmin,
            conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
          },
        }),
        201,
      )) as never,
    );
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const pending = view.tasks.filter((task) => task.status === 'pending');
    expect(pending).toEqual([
      expect.objectContaining({ nodeKey: 'owner_node', assigneeUserId: w.hr.id, origin: 'resolved' }),
    ]);
    expect(view.tasks.some((task) => task.origin === 'self_skip')).toBe(false);
  });

  it('存量节点保持冻结的列值：列值为 true 的已发布版本仍自审回避', async () => {
    const w = await approvalWorld(database().db, 'f048-legacy-frozen');
    const s = await transferScene(w);
    const created = await w.createProcess({
      nodes: [{ key: 'owner_node', approver: 'owner', actions: { avoidSelf: false } }],
    });
    // 可信夹具（连接角色直写）：模拟迁移前写入、列值为 true 的节点（迁移只改列缺省值，不改存量行）
    await w.db.execute(sql`UPDATE approval_process_nodes SET avoid_self=true WHERE tenant_id=${w.tenant.id}
      AND version_id IN (SELECT id FROM approval_process_versions WHERE process_id=${created.id}::uuid)`);
    const process = await getProcess(w, created.id);
    expect(nodeOf(process, 'owner_node').actions.avoidSelf).toBe(true);
    await w.publish(process as never);
    const view: InstanceView = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view.tasks.some((task) => task.origin === 'self_skip' && task.assigneeUserId === w.hr.id)).toBe(true);
  });
});

describe('T11 草稿整份替换与新版本', () => {
  it('漏传开关的已有节点沿用当前草稿值，新节点取缺省（关闭），显式值优先', async () => {
    const w = await approvalWorld(database().db, 'f048-draft-inherit');
    const created = await w.createProcess({
      nodes: [
        { key: 'a', approver: 'owner', actions: { avoidSelf: true } },
        { key: 'b', approver: 'record_department_head', actions: { avoidSelf: true } },
      ],
    });
    const replaced = await w.json<Process>(
      await w.request(w.hr.id, 'PUT', `${BASE}/processes/${created.id}/draft`, {
        ifMatch: created.revision,
        body: {
          name: '草稿二',
          exceptionAdminUserId: w.exceptionAdmin,
          conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
          nodes: [
            { key: 'a', approver: 'owner' },
            { key: 'b', approver: 'record_department_head', actions: { avoidSelf: false } },
            { key: 'c', approver: 'record_department_hrbp' },
          ],
        },
      }),
    );
    expect(nodeOf(replaced, 'a').actions).toMatchObject({ avoidSelf: true, avoidSubjects: false });
    expect(nodeOf(replaced, 'b').actions).toMatchObject({ avoidSelf: false, avoidSubjects: false });
    expect(nodeOf(replaced, 'c').actions).toMatchObject({ avoidSelf: false, avoidSubjects: false });
  });

  it('新版本逐节点复制上一版本的开关值', async () => {
    const w = await approvalWorld(database().db, 'f048-new-version');
    const published = await w.publishedProcess({
      nodes: [
        { key: 'a', approver: 'owner', actions: { avoidSelf: true } },
        { key: 'b', approver: 'record_department_head', actions: { avoidSelf: false } },
      ],
    });
    const next = await w.json<Process>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${published.id}/versions`, { ifMatch: published.revision }),
      201,
    );
    expect(next.latestVersion.status).toBe('draft');
    expect(nodeOf(next, 'a').actions).toMatchObject({ avoidSelf: true, avoidSubjects: false });
    expect(nodeOf(next, 'b').actions).toMatchObject({ avoidSelf: false, avoidSubjects: false });
  });
});

describe('T11 R3-01：PR-1 阶段不能开启多主体回避', () => {
  it('新建流程开启 avoidSubjects → 400 APPROVAL_AVOID_SUBJECTS_UNAVAILABLE，不建流程', async () => {
    const w = await approvalWorld(database().db, 'f048-unavailable-create');
    const response = await createRaw(w, 'transfer', [
      { key: 'n1', approver: 'owner', actions: { avoidSubjects: true } },
    ]);
    expect(await reasonOf(response)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'APPROVAL_AVOID_SUBJECTS_UNAVAILABLE',
    });
    const list = await w.json<{ items: unknown[] }>(await w.request(w.hr.id, 'GET', `${BASE}/processes`));
    expect(list.items).toEqual([]);
  });

  it('会签节点开启也同样拒绝', async () => {
    const w = await approvalWorld(database().db, 'f048-unavailable-countersign');
    const response = await createRaw(w, 'transfer', [
      {
        key: 'cs',
        kind: 'countersign',
        approvers: ['owner', 'record_department_head'],
        actions: { avoidSubjects: true },
      },
    ]);
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNAVAILABLE' });
  });

  it('草稿替换开启 → 400，草稿前后不变', async () => {
    const w = await approvalWorld(database().db, 'f048-unavailable-draft');
    const created = await w.createProcess({ nodes: [{ key: 'a', approver: 'owner' }] });
    const before = await getProcess(w, created.id);
    const response = await w.request(w.hr.id, 'PUT', `${BASE}/processes/${created.id}/draft`, {
      ifMatch: created.revision,
      body: {
        name: '草稿二',
        exceptionAdminUserId: w.exceptionAdmin,
        nodes: [{ key: 'a', approver: 'owner', actions: { avoidSubjects: true } }],
      },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNAVAILABLE' });
    expect(await getProcess(w, created.id)).toEqual(before);
  });

  it('发布时复核：草稿里出现 avoid_subjects=true（可信夹具写入）→ 400，仍是草稿', async () => {
    const w = await approvalWorld(database().db, 'f048-unavailable-publish');
    const created = await w.createProcess({ nodes: [{ key: 'a', approver: 'owner' }] });
    await w.db.execute(sql`UPDATE approval_process_nodes SET avoid_subjects=true WHERE tenant_id=${w.tenant.id}
      AND version_id IN (SELECT id FROM approval_process_versions WHERE process_id=${created.id}::uuid)`);
    const response = await w.request(w.hr.id, 'POST', `${BASE}/processes/${created.id}/publish`, {
      ifMatch: created.revision,
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNAVAILABLE' });
    expect((await getProcess(w, created.id)).latestVersion.status).toBe('draft');
  });
});

describe('T11 DEC-331⑤：命中动作只启用「跳过」', () => {
  for (const result of ['approve', 'disagree', 'exit:custom_action']) {
    it(`avoidSubjectsResult=${result} → 400 APPROVAL_AVOID_SUBJECTS_RESULT_UNSUPPORTED`, async () => {
      const w = await approvalWorld(database().db, `f048-result-${result.replace(':', '-')}`);
      const response = await createRaw(w, 'transfer', [{ key: 'n1', approver: 'owner', avoidSubjectsResult: result }]);
      expect(await reasonOf(response)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'APPROVAL_AVOID_SUBJECTS_RESULT_UNSUPPORTED',
      });
    });
  }

  it('不在契约内的取值 → 400 VALIDATION_FAILED（格式错误）', async () => {
    const w = await approvalWorld(database().db, 'f048-result-bogus');
    const response = await createRaw(w, 'transfer', [{ key: 'n1', approver: 'owner', avoidSubjectsResult: 'bogus' }]);
    expect(await reasonOf(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('T11 DEC-332①：预置按业务敏感度显式取值（设计 §3.3）', () => {
  it('非 IDP 预置 avoidSelf=true，IDP 预置 avoidSelf=false，全部 avoidSubjects=false', async () => {
    const w = await approvalWorld(database().db, 'f048-presets');
    const installed = await w.json<{ items: Process[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    expect(installed.items).toHaveLength(PRESET_PROCESSES.length);
    for (const item of installed.items) {
      const process = await getProcess(w, item.id);
      const idp = item.approvalType.startsWith('idp_');
      for (const node of process.latestVersion.nodes) {
        expect(node.actions, `${item.approvalType}.${node.key}`).toMatchObject({
          avoidSelf: !idp,
          avoidSubjects: false,
        });
        expect(node.avoidSubjectsResult).toBe('skip');
      }
    }
  });
});
