/**
 * F-048 PR-1 开关的输入 / 存储 / 回显与缺省值（docs/08_设计/F-048_审批多主体回避_设计.md §3，测试 T11）：
 * - DEC-329④：管理员新建节点不给开关即关闭；草稿整份替换漏传时沿用该节点当前值；新版本复制；回显始终显式；
 * - 存量节点保持冻结的列值；DEC-332①：预置按业务敏感度显式取值（非 IDP true、IDP false），avoidSubjects 只有集合审批的
 *   盘点结果审批预置为 true（R3-T04 设计 §3.3 D-34），其余单主体预置 false；
 * - PR-2：avoidSubjects 放开——会签或无「同意」出口的节点开启 → 400 UNSUPPORTED（保存 / 草稿 / 发布 / 写入层各自复核）；
 *   DEC-331⑤：命中动作只启用「跳过」。
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

/**
 * 可信夹具：以连接角色（表属主）在本租户上下文里直写草稿节点（应用角色对节点表没有 UPDATE 权限）。真 PG 上表强制 RLS，
 * 须先设 app.tenant_id 才看得到本租户的行。
 */
async function patchDraftNodes(w: ApprovalWorld, processId: string, set: ReturnType<typeof sql>) {
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`UPDATE approval_process_nodes SET ${set} WHERE tenant_id=${w.tenant.id}
      AND version_id IN (SELECT id FROM approval_process_versions WHERE process_id=${processId}::uuid)`);
  });
}

/**
 * 可信夹具：已发布版本的节点受“仅草稿可改”触发器保护，属主在同一事务内临时停用该触发器后直写，提交前恢复。
 * 模拟运行判定上线（PR-2）后已开启、又回到只拒绝开启的代码时的存量版本。
 */
async function patchPublishedNodes(w: ApprovalWorld, processId: string, set: ReturnType<typeof sql>) {
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`ALTER TABLE approval_process_nodes DISABLE TRIGGER approval_nodes_draft_only`);
    await tx.execute(sql`UPDATE approval_process_nodes SET ${set} WHERE tenant_id=${w.tenant.id}
      AND version_id IN (SELECT id FROM approval_process_versions WHERE process_id=${processId}::uuid)`);
    await tx.execute(sql`ALTER TABLE approval_process_nodes ENABLE TRIGGER approval_nodes_draft_only`);
  });
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
    await patchDraftNodes(w, created.id, sql`avoid_self=true`);
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

const COUNTERSIGN = { key: 'cs', kind: 'countersign', approvers: ['owner', 'record_department_head'] } as const;

describe('T11 PR-2 放开 avoidSubjects：单人且有「同意」出口的节点可开启，其余 400 UNSUPPORTED', () => {
  it('新建流程在单人节点开启 avoidSubjects → 201，回显显式 true', async () => {
    const w = await approvalWorld(database().db, 'f048-enabled-create');
    const created = await w.json<Process>(
      await createRaw(w, 'transfer', [{ key: 'n1', approver: 'owner', actions: { avoidSubjects: true } }]),
      201,
    );
    expect(nodeOf(created, 'n1').actions.avoidSubjects).toBe(true);
  });

  it('新建流程在会签节点 / 无「同意」出口节点开启 → 400 APPROVAL_AVOID_SUBJECTS_UNSUPPORTED，不建流程', async () => {
    const w = await approvalWorld(database().db, 'f048-unsupported-create');
    for (const node of [
      { ...COUNTERSIGN, actions: { avoidSubjects: true } },
      { key: 'n1', approver: 'owner', exits: ['disagree'], actions: { avoidSubjects: true } },
    ]) {
      const response = await createRaw(w, 'transfer', [node]);
      expect(await reasonOf(response)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED',
      });
    }
    const list = await w.json<{ items: unknown[] }>(await w.request(w.hr.id, 'GET', `${BASE}/processes`));
    expect(list.items).toEqual([]);
  });

  it('草稿替换在会签节点开启 → 400，草稿前后不变', async () => {
    const w = await approvalWorld(database().db, 'f048-unsupported-draft');
    const created = await w.createProcess({ nodes: [{ key: 'a', approver: 'owner' }] });
    const before = await getProcess(w, created.id);
    const response = await w.request(w.hr.id, 'PUT', `${BASE}/processes/${created.id}/draft`, {
      ifMatch: created.revision,
      body: {
        name: '草稿二',
        exceptionAdminUserId: w.exceptionAdmin,
        nodes: [{ ...COUNTERSIGN, actions: { avoidSubjects: true } }],
      },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED' });
    expect(await getProcess(w, created.id)).toEqual(before);
  });

  it('发布时复核：会签草稿里出现 avoid_subjects=true（可信夹具写入）→ 400，仍是草稿', async () => {
    const w = await approvalWorld(database().db, 'f048-unsupported-publish');
    const created = await w.createProcess({ nodes: [COUNTERSIGN] });
    await patchDraftNodes(w, created.id, sql`avoid_subjects=true`);
    const response = await w.request(w.hr.id, 'POST', `${BASE}/processes/${created.id}/publish`, {
      ifMatch: created.revision,
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED' });
    expect((await getProcess(w, created.id)).latestVersion.status).toBe('draft');
  });
});

describe('T11 写入层独立复核（不依赖请求入口的校验）', () => {
  it('草稿整份替换沿用到的会签 avoidSubjects=true（可信夹具写入）→ 400，草稿前后不变', async () => {
    const w = await approvalWorld(database().db, 'f048-gate-inherit');
    const created = await w.createProcess({ nodes: [COUNTERSIGN] });
    await patchDraftNodes(w, created.id, sql`avoid_subjects=true`);
    const before = await getProcess(w, created.id);
    const response = await w.request(w.hr.id, 'PUT', `${BASE}/processes/${created.id}/draft`, {
      ifMatch: created.revision,
      body: { name: '草稿二', exceptionAdminUserId: w.exceptionAdmin, nodes: [COUNTERSIGN] },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED' });
    expect(await getProcess(w, created.id)).toEqual(before);
  });

  it('新版本复制到会签 avoidSubjects=true（可信夹具写入已发布版本）→ 400，不生成草稿', async () => {
    const w = await approvalWorld(database().db, 'f048-gate-version');
    const published = await w.publishedProcess({ nodes: [COUNTERSIGN] });
    await patchPublishedNodes(w, published.id, sql`avoid_subjects=true`);
    const response = await w.request(w.hr.id, 'POST', `${BASE}/processes/${published.id}/versions`, {
      ifMatch: published.revision,
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED' });
    expect((await getProcess(w, published.id)).latestVersion.status).toBe('published');
  });

  it('异常管理员交接重发到会签 avoidSubjects=true（可信夹具写入已发布版本）→ 400，不重发', async () => {
    const w = await approvalWorld(database().db, 'f048-gate-handover');
    const published = await w.publishedProcess({ nodes: [COUNTERSIGN] });
    await patchPublishedNodes(w, published.id, sql`avoid_subjects=true`);
    const before = await getProcess(w, published.id);
    const successor = await w.member('新异常管理员');
    const response = await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED' });
    expect(await getProcess(w, published.id)).toEqual(before);
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
  it('非 IDP 预置 avoidSelf=true，IDP 预置 avoidSelf=false；只有盘点结果审批 avoidSubjects=true（D-34）', async () => {
    const w = await approvalWorld(database().db, 'f048-presets');
    const installed = await w.json<{ items: Process[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    expect(installed.items).toHaveLength(PRESET_PROCESSES.length);
    for (const item of installed.items) {
      const process = await getProcess(w, item.id);
      const idp = item.approvalType.startsWith('idp_');
      // R3-T04 设计 §3.3 D-34：集合审批（一单多个被盘点人）的盘点结果审批预置显式开启多主体回避
      const collective = item.approvalType === 'talent_review_result';
      for (const node of process.latestVersion.nodes) {
        expect(node.actions, `${item.approvalType}.${node.key}`).toMatchObject({
          avoidSelf: !idp,
          avoidSubjects: collective,
        });
        expect(node.avoidSubjectsResult).toBe('skip');
      }
    }
  });
});
