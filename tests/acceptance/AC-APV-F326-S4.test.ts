/**
 * F-326 S4（设计 §8 行 S4）：三类来源接入流程。
 * AC-APV-F326-08（S4 部分）/ 10 / 11 / 12 / 16 / 17；AC-13 / 18 在 AC-APV-F326-S4-lifecycle.test.ts。
 * 全部经真实 HTTP 入口与引擎；租户数据用 withTenant 读取，可在 app_owner 下通过。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { change, job, orgVersion, resolved, source } from './AC-APV-F318c-support.js';
import {
  MATRICES,
  VARIABLES,
  counter,
  dropRoleColumn,
  matrix,
  matrixSource,
  matrixStatus,
  readMatrix,
  readVariable,
  rejected,
  reorderRows,
  republish,
  references,
  s4World,
  saveNodes,
  variable,
  variableCommand,
  varSource,
  type S4World,
} from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const VARIABLE_INVALID = 'APPROVAL_SOURCE_VARIABLE_INVALID';
const MATRIX_INVALID = 'APPROVAL_SOURCE_MATRIX_INVALID';
const randomId = () => crypto.randomUUID();

/** 已离职账号：直接离职业务，离职日早于业务日。 */
async function depart(w: S4World, employeeId: string) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
  );
  await w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-02' },
    }),
    201,
  );
}

describe('AC-APV-F326-12 保存校验：公共变量 / 应用变量', () => {
  it('启用的公共人员变量可保存；不存在与他租户变量 422', async () => {
    const w = await s4World(database().db, 'save-var');
    const v = await variable(w);
    await w.json(await saveNodes(w, [counter([varSource('public_variable', v.id)])]), 201);

    const missing = await rejected(
      await saveNodes(w, [counter([varSource('public_variable', randomId())])]),
      422,
      VARIABLE_INVALID,
    );
    expect(missing.message).toContain('引用不存在');
    const other = await s4World(database().db, 'save-var-other');
    const foreign = await variable(other);
    await rejected(await saveNodes(w, [counter([varSource('public_variable', foreign.id)])]), 422, VARIABLE_INVALID);
  });

  it('草稿、已停用变量不能保存；非人员类型不能保存', async () => {
    const w = await s4World(database().db, 'save-state');
    const draft = await variable(w, { enable: false });
    await rejected(await saveNodes(w, [counter([varSource('public_variable', draft.id)])]), 422, VARIABLE_INVALID);
    const enabled = await variable(w);
    const disabled = await variableCommand(w, enabled, 'disable');
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    await rejected(await saveNodes(w, [counter([varSource('public_variable', enabled.id)])]), 422, VARIABLE_INVALID);
    const text = await variable(w, { dataType: 'string', defaultValue: '文本' });
    await rejected(await saveNodes(w, [counter([varSource('public_variable', text.id)])]), 422, VARIABLE_INVALID);
  });

  it('公共变量适用范围不含“流程”不能保存', async () => {
    const w = await s4World(database().db, 'save-scope');
    const v = await variable(w, { usageScopes: ['business_rule'] });
    const error = await rejected(
      await saveNodes(w, [counter([varSource('public_variable', v.id)])]),
      422,
      VARIABLE_INVALID,
    );
    expect(error.message).toContain('流程');
  });

  it('AC-08：应用变量按流程审批类型的应用归属校验', async () => {
    const w = await s4World(database().db, 'save-app');
    const transfer = await variable(w, { scope: 'application', appId: 'transfer' });
    const staff = await variable(w, { scope: 'application', appId: 'staff' });
    // leave 归调动应用，contract_create 归员工应用（APPROVAL_TYPE_APPS）
    await w.json(await saveNodes(w, [counter([varSource('application_variable', transfer.id)])], 'leave'), 201);
    await w.json(await saveNodes(w, [counter([varSource('application_variable', staff.id)])], 'contract_create'), 201);
    await rejected(
      await saveNodes(w, [counter([varSource('application_variable', staff.id)])], 'leave'),
      422,
      VARIABLE_INVALID,
    );
    await rejected(
      await saveNodes(w, [counter([varSource('application_variable', transfer.id)])], 'contract_create'),
      422,
      VARIABLE_INVALID,
    );
  });

  it('单人节点：多人变量拒绝，人员变量可用；会签 / 或签可用多人变量', async () => {
    const w = await s4World(database().db, 'save-single');
    const many = await variable(w, { dataType: 'persons', defaultValue: [w.near.userId, w.head.userId] });
    const one = await variable(w);
    const single = (id: string) => ({ key: 'n1', approver: varSource('public_variable', id) });
    const error = await rejected(await saveNodes(w, [single(many.id)]), 422, VARIABLE_INVALID);
    expect(error.message).toBe('多人变量只能用于会签或或签节点');
    await w.json(await saveNodes(w, [single(one.id)]), 201);
    await w.json(await saveNodes(w, [counter([varSource('public_variable', many.id)])]), 201);
    await w.json(
      await saveNodes(w, [counter([varSource('public_variable', many.id)], { transitionRule: { type: 'any' } })]),
      201,
    );
  });
});

describe('AC-APV-F326-12 保存校验：审批矩阵', () => {
  const rows = (w: S4World) => [{ cond: [w.child], role: [w.head.userId] }];

  it('启用矩阵的角色列可保存；条件列、他矩阵的列、不存在的矩阵与列 422', async () => {
    const w = await s4World(database().db, 'save-matrix');
    const m = await matrix(w, { rows: rows(w) });
    await w.json(await saveNodes(w, [counter([matrixSource(m, m.roleId)])]), 201);
    await rejected(await saveNodes(w, [counter([matrixSource(m, m.conditionId)])]), 422, MATRIX_INVALID);
    await rejected(await saveNodes(w, [counter([matrixSource(m, randomId())])]), 422, MATRIX_INVALID);
    const other = await matrix(w, { rows: rows(w) });
    await rejected(
      await saveNodes(w, [counter([{ type: 'matrix', value: `${m.id}:${other.roleId}` }])]),
      422,
      MATRIX_INVALID,
    );
    const missing = await rejected(
      await saveNodes(w, [counter([matrixSource({ id: randomId() }, randomId())])]),
      422,
      MATRIX_INVALID,
    );
    expect(missing.message).toContain('引用不存在');
  });

  it('草稿 / 已停用矩阵不能保存；他租户矩阵不能保存', async () => {
    const w = await s4World(database().db, 'save-matrix-state');
    const draft = await matrix(w, { rows: rows(w), enable: false });
    await rejected(await saveNodes(w, [counter([matrixSource(draft, draft.roleId)])]), 422, MATRIX_INVALID);
    const m = await matrix(w, { rows: rows(w) });
    const disabled = await matrixStatus(w, m, 'disable');
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    await rejected(await saveNodes(w, [counter([matrixSource(m, m.roleId)])]), 422, MATRIX_INVALID);
    const other = await s4World(database().db, 'save-matrix-other');
    const foreign = await matrix(other, { rows: rows(other) });
    await rejected(await saveNodes(w, [counter([matrixSource(foreign, foreign.roleId)])]), 422, MATRIX_INVALID);
  });

  it('单人节点：允许多人的角色列拒绝，不允许多人的角色列可用', async () => {
    const w = await s4World(database().db, 'save-matrix-single');
    const many = await matrix(w, { rows: rows(w), allowMultiple: true });
    const one = await matrix(w, { rows: rows(w), allowMultiple: false });
    const single = (m: typeof many) => ({ key: 'n1', approver: matrixSource(m, m.roleId) });
    const error = await rejected(await saveNodes(w, [single(many)]), 422, MATRIX_INVALID);
    expect(error.message).toContain('会签');
    await w.json(await saveNodes(w, [single(one)]), 201);
  });

  it('矩阵需要任职申请业务日：任职类与个人信息变更可用，多主体类型 422', async () => {
    const w = await s4World(database().db, 'save-matrix-type');
    const m = await matrix(w, { rows: rows(w) });
    const nodes = [counter([matrixSource(m, m.roleId)])];
    for (const type of ['transfer', 'exit_handover', 'personnel_change'])
      await w.json(await saveNodes(w, nodes, type), 201);
    for (const type of ['offer', 'org_adjustment', 'talent_review_result']) {
      const error = await rejected(await saveNodes(w, nodes, type), 422);
      expect(error.message, type).toContain('该审批类型没有任职申请业务日');
    }
  });

  it('来源值格式：矩阵必须是“矩阵:角色列”，变量必须是单个 ID', async () => {
    const w = await s4World(database().db, 'save-format');
    for (const bad of [
      { type: 'matrix', value: randomId() },
      { type: 'matrix', value: `${randomId()}:${randomId()}:x` },
      { type: 'public_variable', value: `${randomId()}:${randomId()}` },
      { type: 'application_variable', value: 'not-a-uuid' },
    ] as const) {
      const error = await rejected(await saveNodes(w, [counter([bad])]), 422);
      expect(error.message, bad.value).toContain('审批人来源的值不合法');
    }
  });
});

describe('AC-APV-F326-10 矩阵求值', () => {
  it('部门维度：取第一条命中的行（按 seq），改序后随之变化', async () => {
    const w = await s4World(database().db, 'eval-seq');
    const spec = {
      rows: [
        { cond: [w.staff], role: [w.head.userId] },
        { cond: [w.child], role: [w.near.userId] },
        { cond: [w.child], role: [w.head.userId] },
      ],
    };
    const m = await matrix(w, spec);
    expect(await resolved(w, matrixSource(m, m.roleId))).toEqual([w.near.userId]);
    const swapped = await reorderRows(w, m, spec, [2, 0, 1]);
    expect(await resolved(w, matrixSource(swapped, swapped.roleId))).toEqual([w.head.userId]);
  });

  it('空条件单元不限制；有条件未命中的行跳过', async () => {
    const w = await s4World(database().db, 'eval-empty-cell');
    const m = await matrix(w, {
      rows: [
        { cond: [w.staff], role: [w.near.userId] },
        { cond: [], role: [w.head.userId] },
      ],
    });
    expect(await resolved(w, matrixSource(m, m.roleId))).toEqual([w.head.userId]);
  });

  it('含下级：沿行政祖先链（业务日版本）命中；不含下级只认本部门', async () => {
    const w = await s4World(database().db, 'eval-children');
    const rows = [{ cond: [w.root], role: [w.head.userId] }];
    const include = await matrix(w, { rows, includeChildren: true });
    const exact = await matrix(w, { rows, includeChildren: false });
    expect(await resolved(w, matrixSource(include, include.roleId))).toEqual([w.head.userId]);
    expect(await resolved(w, matrixSource(exact, exact.roleId))).toEqual([]);
    // 9 月起子部门改隶属人员部门：8 月业务日仍在根下，10 月不在
    await orgVersion(w, w.child, { startDate: '2026-09-01' }, { admin: w.staff });
    expect(await resolved(w, matrixSource(include, include.roleId), '2026-08-01')).toEqual([w.head.userId]);
    expect(await resolved(w, matrixSource(include, include.roleId), '2026-10-01')).toEqual([]);
  });

  it('职位 / 职务维度：取申请对象业务日的主职，历史日期各取各的', async () => {
    const w = await s4World(database().db, 'eval-job');
    const post = await job(w, 'posts');
    const position = await job(w, 'positions', { postId: post.id, orgId: w.child });
    await change(w, w.subject.employeeId, { positionId: position.id, postId: post.id }, '2026-07-01');
    await change(w, w.subject.employeeId, { positionId: null, postId: null }, '2026-09-01');
    for (const [dimension, id] of [
      ['position', position.id],
      ['job', post.id],
    ] as const) {
      const m = await matrix(w, { dimension, rows: [{ cond: [id], role: [w.head.userId] }] });
      expect(await resolved(w, matrixSource(m, m.roleId), '2026-08-01'), dimension).toEqual([w.head.userId]);
      expect(await resolved(w, matrixSource(m, m.roleId), '2026-10-01'), dimension).toEqual([]);
    }
  });

  it('真实派单：任职申请的目标部门命中矩阵行，任务派给角色列人员', async () => {
    const w = await s4World(database().db, 'eval-instance');
    const m = await matrix(w, {
      rows: [
        { cond: [w.child], role: [w.near.userId] },
        { cond: [w.staff], role: [w.head.userId] },
      ],
    });
    await w.publishedProcess({ nodes: [counter([matrixSource(m, m.roleId)])] });
    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    expect(w.pending(instance).map((task) => task.assigneeUserId)).toEqual([w.head.userId]);
  });
});

describe('AC-APV-F326-10 变量取值', () => {
  it('公共 / 应用变量取默认值里的人员，多人变量全部取到', async () => {
    const w = await s4World(database().db, 'eval-var');
    const publicVar = await variable(w);
    const appVar = await variable(w, { scope: 'application', appId: 'transfer', defaultValue: w.head.userId });
    const many = await variable(w, { dataType: 'persons', defaultValue: [w.near.userId, w.head.userId] });
    expect(await resolved(w, varSource('public_variable', publicVar.id))).toEqual([w.near.userId]);
    expect(await resolved(w, varSource('application_variable', appVar.id))).toEqual([w.head.userId]);
    expect(await resolved(w, varSource('public_variable', many.id))).toEqual([w.near.userId, w.head.userId].sort());
  });

  it('真实派单：变量节点任务派给变量当前人员', async () => {
    const w = await s4World(database().db, 'eval-var-instance');
    const v = await variable(w);
    await w.publishedProcess({ nodes: [counter([varSource('public_variable', v.id)])] });
    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    expect(w.pending(instance).map((task) => task.assigneeUserId)).toEqual([w.near.userId]);
  });
});

describe('AC-APV-F326-11 取值为空与失效', () => {
  it('未命中、角色格为空、矩阵 / 变量停用、人员离职：都得到空名单', async () => {
    const w = await s4World(database().db, 'eval-empty');
    const noHit = await matrix(w, { rows: [{ cond: [w.staff], role: [w.head.userId] }] });
    expect(await resolved(w, matrixSource(noHit, noHit.roleId))).toEqual([]);
    const noRole = await matrix(w, { rows: [{ cond: [w.child], role: [] }] });
    expect(await resolved(w, matrixSource(noRole, noRole.roleId))).toEqual([]);

    const stopped = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    expect(await resolved(w, matrixSource(stopped, stopped.roleId))).toEqual([w.head.userId]);
    expect((await matrixStatus(w, stopped, 'disable')).status).toBe(200);
    expect(await resolved(w, matrixSource(stopped, stopped.roleId))).toEqual([]);

    const v = await variable(w);
    expect(await resolved(w, varSource('public_variable', v.id))).toEqual([w.near.userId]);
    expect((await variableCommand(w, v, 'disable')).status).toBe(200);
    expect(await resolved(w, varSource('public_variable', v.id))).toEqual([]);
  });

  it('角色格里的非成员与已离职人员被过滤；人员变量的人员离职后取空', async () => {
    const w = await s4World(database().db, 'eval-filter');
    const left = await w.person('合成离职人', w.staff);
    const m = await matrix(w, {
      rows: [{ cond: [w.child], role: [left.userId, randomId(), w.near.userId] }],
    });
    const v = await variable(w, { defaultValue: left.userId });
    expect(await resolved(w, matrixSource(m, m.roleId))).toEqual([left.userId, w.near.userId].sort());
    expect(await resolved(w, varSource('public_variable', v.id))).toEqual([left.userId]);
    await depart(w, left.employeeId);
    expect(await resolved(w, matrixSource(m, m.roleId))).toEqual([w.near.userId]);
    expect(await resolved(w, varSource('public_variable', v.id))).toEqual([]);
  });

  it('旧定义里失效的角色列运行时取空，不抛错', async () => {
    const w = await s4World(database().db, 'eval-missing-column');
    const m = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    expect(await resolved(w, matrixSource(m, randomId()))).toEqual([]);
    expect(await resolved(w, source('matrix', randomId(), `:${randomId()}`))).toEqual([]);
  });
});

describe('AC-APV-F326-16 查看引用', () => {
  it('草稿、当前发布、在途旧版本都列出；终态实例的旧版本不列', async () => {
    const w = await s4World(database().db, 'refs-kinds');
    const v = await variable(w);
    const other = await variable(w);
    const process = await w.publishedProcess({
      code: `REF_${Date.now()}`,
      name: '引用测试流程',
      nodes: [counter([varSource('public_variable', v.id)], { name: '变量节点' })],
    });
    expect((await references(w, 'variables', other.id)).items).toEqual([]);

    // v1 有在途实例 → 发布 v2（不再引用）后，v1 仍算在用
    const running = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    const v2 = await republish(w, process, [counter([{ type: 'specified', value: w.head.userId }])]);
    let shown = await references(w, 'variables', v.id);
    expect(shown.total).toBe(1);
    expect(shown.items[0]).toMatchObject({
      processCode: process.code,
      processName: '引用测试流程',
      approvalType: 'transfer',
      versionKind: 'in_flight',
      versionNo: 1,
      nodeKey: 'n1',
      nodeName: '变量节点',
      position: 'approver',
      instanceCount: 1,
    });

    // 草稿 v3 引用 → 增加一行 draft
    await republishDraftOnly(w, v2, v.id);
    shown = await references(w, 'variables', v.id);
    expect(shown.items.map((item) => [item.versionKind, item.versionNo]).sort()).toEqual([
      ['draft', 3],
      ['in_flight', 1],
    ]);
    // 实例结束后 v1 不再算在用
    const task = w.pending(running)[0]!;
    expect((await w.taskAction(task.assigneeUserId, task.id, 'approve', running.revision, {})).status).toBe(200);
    shown = await references(w, 'variables', v.id);
    expect(shown.items.map((item) => item.versionKind)).toEqual(['draft']);
  });

  it('当前发布版本列为 current；矩阵引用给出角色列，只列引用到本矩阵的节点', async () => {
    const w = await s4World(database().db, 'refs-matrix');
    const m = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    const unused = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    await w.publishedProcess({ nodes: [counter([matrixSource(m, m.roleId)])] });
    const shown = await references(w, 'matrices', m.id);
    expect(shown.total).toBe(1);
    expect(shown.items[0]).toMatchObject({ versionKind: 'current', columnId: m.roleId, instanceCount: null });
    expect((await references(w, 'matrices', unused.id)).items).toEqual([]);
  });

  it('不存在或他租户的变量 / 矩阵 404', async () => {
    const w = await s4World(database().db, 'refs-404');
    const other = await s4World(database().db, 'refs-404-other');
    const own = await variable(w);
    const ownMatrix = await matrix(w, { rows: [] });
    expect((await references(w, 'variables', own.id)).items).toEqual([]);
    expect((await references(w, 'matrices', ownMatrix.id)).items).toEqual([]);
    const foreign = await variable(other);
    const foreignMatrix = await matrix(other, { rows: [] });
    for (const [kind, id] of [
      ['variables', randomId()],
      ['variables', foreign.id],
      ['matrices', randomId()],
      ['matrices', foreignMatrix.id],
    ] as const) {
      const response = await w.request(w.hr.id, 'GET', `/api/tenant/approval/${kind}/${id}/references`);
      expect(response.status, `${kind}/${id}`).toBe(404);
    }
  });
});

/** 在已发布流程上开草稿并加上一个变量引用，但不发布。 */
async function republishDraftOnly(
  w: S4World,
  process: { id: string; revision: number },
  variableId: string,
): Promise<void> {
  const base = `/api/tenant/approval/processes/${process.id}`;
  const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', base));
  const draft = await w.json<{ revision: number; latestVersion: Record<string, unknown> }>(
    await w.request(w.hr.id, 'POST', `${base}/versions`, { ifMatch: current.revision, body: {} }),
    201,
  );
  const version = draft.latestVersion;
  const nodes = [counter([varSource('public_variable', variableId)])].map((node) => ({
    ...node,
    actions: { avoidSelf: true },
  }));
  await w.json(
    await w.request(w.hr.id, 'PUT', `${base}/draft`, {
      ifMatch: draft.revision,
      body: {
        name: version.name,
        priority: version.priority,
        isFallback: version.isFallback,
        exceptionAdminUserId: version.exceptionAdminUserId,
        conditions: version.conditions,
        nodes,
      },
    }),
  );
}

describe('AC-APV-F326-17 停用 / 编辑影响检查与删角色列', () => {
  async function referencedVariable(w: S4World) {
    const v = await variable(w);
    await w.publishedProcess({ nodes: [counter([varSource('public_variable', v.id)])] });
    return v;
  }

  it('变量停用：有引用时须带与当前引用数一致的确认数；不一致 409 且状态不变', async () => {
    const w = await s4World(database().db, 'ack-var');
    const v = await referencedVariable(w);
    for (const body of [{}, { acknowledgedReferenceCount: 0 }, { acknowledgedReferenceCount: 2 }]) {
      const error = await rejected(await variableCommand(w, v, 'disable', body), 409, 'APPROVAL_REFERENCES_CHANGED');
      expect(error.code).toBe('CONFLICT');
      expect((await readVariable(w, v.id)).status).toBe('enabled');
    }
    const ok = await variableCommand(w, v, 'disable', { acknowledgedReferenceCount: 1 });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await readVariable(w, v.id)).status).toBe('disabled');
  });

  it('确认之后又新增了引用：同一确认数被拒', async () => {
    const w = await s4World(database().db, 'ack-race');
    const v = await referencedVariable(w);
    const shown = await references(w, 'variables', v.id);
    await w.publishedProcess({ priority: 1, nodes: [counter([varSource('public_variable', v.id)])] });
    await rejected(
      await variableCommand(w, v, 'disable', { acknowledgedReferenceCount: shown.total }),
      409,
      'APPROVAL_REFERENCES_CHANGED',
    );
    expect((await readVariable(w, v.id)).status).toBe('enabled');
  });

  it('无引用的变量不带确认数也能停用', async () => {
    const w = await s4World(database().db, 'ack-none');
    const v = await variable(w);
    expect((await variableCommand(w, v, 'disable')).status).toBe(200);
  });

  it('公共变量把“流程”移出适用范围：同样要求确认数', async () => {
    const w = await s4World(database().db, 'ack-scope');
    const v = await referencedVariable(w);
    const patch = (extra = {}) =>
      w.request(w.hr.id, 'PATCH', `${VARIABLES}/${v.id}`, {
        ifMatch: v.revision,
        body: { usageScopes: ['business_rule'], ...extra },
      });
    await rejected(await patch(), 409, 'APPROVAL_REFERENCES_CHANGED');
    expect((await readVariable(w, v.id)).revision).toBe(v.revision);
    const ok = await patch({ acknowledgedReferenceCount: 1 });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('矩阵停用同样要求确认数', async () => {
    const w = await s4World(database().db, 'ack-matrix');
    const m = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    await w.publishedProcess({ nodes: [counter([matrixSource(m, m.roleId)])] });
    await rejected(await matrixStatus(w, m, 'disable'), 409, 'APPROVAL_REFERENCES_CHANGED');
    await rejected(
      await matrixStatus(w, m, 'disable', { acknowledgedReferenceCount: 2 }),
      409,
      'APPROVAL_REFERENCES_CHANGED',
    );
    expect((await readMatrix(w, m.id)).status).toBe('enabled');
    const ok = await matrixStatus(w, m, 'disable', { acknowledgedReferenceCount: 1 });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('删除被引用的角色列 409（草稿也算）；没有引用时可删；条件列随时可删', async () => {
    const w = await s4World(database().db, 'drop-column');
    const m = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    // 仅草稿引用
    const draft = await w.json<{ id: string; revision: number; latestVersion: Record<string, unknown> }>(
      await saveNodes(w, [counter([matrixSource(m, m.roleId)])]),
      201,
    );
    const error = await rejected(await dropRoleColumn(w, m), 409, undefined);
    expect(error.code).toBe('CONFLICT');
    expect(JSON.stringify(error)).toContain('APPROVAL_MATRIX_COLUMN_REFERENCED');
    expect((await readMatrix(w, m.id)).columns.map((column) => column.id).sort()).toEqual(
      [m.conditionId, m.roleId].sort(),
    );

    // 草稿改成不引用后可以删
    const version = draft.latestVersion;
    await w.json(
      await w.request(w.hr.id, 'PUT', `/api/tenant/approval/processes/${draft.id}/draft`, {
        ifMatch: draft.revision,
        body: {
          name: version.name,
          priority: version.priority,
          isFallback: version.isFallback,
          exceptionAdminUserId: version.exceptionAdminUserId,
          conditions: version.conditions,
          nodes: [{ ...counter([{ type: 'specified', value: w.head.userId }]), actions: { avoidSelf: true } }],
        },
      }),
    );
    expect((await dropRoleColumn(w, m)).status).toBe(200);
    expect((await readMatrix(w, m.id)).columns.map((column) => column.kind)).toEqual(['condition']);
  });

  it('条件列被删不受引用保护', async () => {
    const w = await s4World(database().db, 'drop-condition');
    const m = await matrix(w, { rows: [{ cond: [w.child], role: [w.head.userId] }] });
    await w.publishedProcess({ nodes: [counter([matrixSource(m, m.roleId)])] });
    const response = await w.request(w.hr.id, 'PUT', `${MATRICES}/${m.id}/structure`, {
      body: {
        revision: m.revision,
        columns: [
          {
            id: m.roleId,
            key: 'r',
            kind: 'role',
            dimension: null,
            includeChildren: false,
            name: '角色',
            allowMultiple: true,
          },
        ],
        rows: m.rows.map((row) => ({ id: row.id, cells: { r: row.cells[m.roleId] ?? [] } })),
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });
});
