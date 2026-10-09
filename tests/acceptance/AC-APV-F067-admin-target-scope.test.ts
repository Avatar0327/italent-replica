/**
 * F-067（#146 / F-066 首轮审查的同类存量问题）：审批中心通用的管理员转交 `admin-transfer` 与管理员干预 `admin-intervene`
 * 的改派分支，转交 / 改派目标须是已绑定员工、且在操作人对该审批业务对象的管理范围内（IDP-R16 “受管理单元限制”；
 * 引用 ID 写入前校验范围）。范围外、未绑定员工的纯账号（待产品确认，先按拒绝）、不存在的账号三种情况返回完全相同的错误，
 * 不暴露存在性；被拒后实例、待办、审计与目标的可见性都不变。
 * 各业务类型按自己的应用范围判断（DEC-043）：任职 / 员工子集按任职记录，合同按合同对象，发展计划按 IDP 计划对象。
 * 范围用测试替身注入（每个对象单独给一份人员范围），其余授权全部允许；实例范围与目标范围用同一份对象范围。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, permissionUserPersonLinks, sql, withTenant, type Db } from '@italent/db';
import { CONTRACT_OBJECT, IDP_OBJECTS, MODULE_OBJECTS, PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '@italent/api';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { contractWorld } from './AC-CT-support.js';
import { planWorld } from './AC-IDP-plan-support.js';
import { NODES, pendingOf, rowsOf } from './support/f048.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const APV = '/api/tenant/approval';
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const IDP_PLAN = IDP_OBJECTS.plan.code;
const CLOCK = new Date('2026-10-01T01:00:00.000Z');
const MISSING_USER = '00000000-0000-4000-8000-0000000000f6';

interface Target {
  readonly userId: string;
  readonly employeeId: string;
}

/** 一个运行中的审批实例 + 它的第一条待办 + 一名范围内目标 / 一名范围外目标 + 一名无关的未绑定员工账号。 */
interface Scene {
  readonly db: Db;
  readonly tenantId: string;
  /** 该业务类型的实例范围按哪个对象判断。 */
  readonly objectCode: string;
  readonly subjectEmployeeId: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly admin: string;
  readonly inside: Target;
  readonly outside: Target;
  readonly plain: string;
}

const personScope = (personIds: readonly string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  personIds: [...personIds],
  hasDataPermission: true,
  terms: [{ dimension: 'management', orgIds: [], personIds: [...personIds] }],
});

/**
 * 操作人的范围：本业务类型对应的对象 = 实例主体 + 范围内目标；另外两个对象 = 实例主体 + 范围外目标
 * （证明判断的是所属应用的范围，而不是借了别的应用的范围）。
 */
function scopedApi(scene: Scene) {
  const authorize: Authorizer = () => true;
  const scopes: Record<string, ModuleScope> = {};
  for (const object of [EMPLOYMENT, CONTRACT_OBJECT, IDP_PLAN]) {
    const other = object === scene.objectCode ? scene.inside : scene.outside;
    scopes[object] = personScope([scene.subjectEmployeeId, other.employeeId]);
  }
  registerScopeProvider(authorize, {
    scope: async (query) => scopes[query.objectCode ?? ''] ?? EMPTY_SCOPE,
    authorize: async () => true,
    fields: async () => new Set<string>(),
  });
  const api = tenantApi(scene.db, { authorize, clock: () => CLOCK });
  return (path: string, revision: number, body: Record<string, unknown>) =>
    api.request('POST', `${APV}/instances/${scene.instanceId}/${path}`, {
      user: scene.admin,
      tenant: scene.tenantId,
      ifMatch: revision,
      body,
    });
}

/** 实例状态快照：revision / 状态、全部任务、管理员审计条数（负例前后比对）。 */
async function snapshotOf(scene: Scene) {
  return withTenant(scene.db, scene.tenantId, async (tx) => {
    const instance = rowsOf<{ revision: number; status: string }>(
      await tx.execute(sql`SELECT revision, status FROM approval_instances WHERE id=${scene.instanceId}::uuid`),
    );
    const tasks = rowsOf<{ id: string; status: string; assignee_user_id: string | null }>(
      await tx.execute(sql`SELECT id::text, status, assignee_user_id::text FROM approval_tasks
        WHERE instance_id=${scene.instanceId}::uuid ORDER BY seq, id`),
    );
    const audits = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
        WHERE object_id=${scene.instanceId} AND action LIKE 'approval.admin.%'`),
    );
    return { instance, tasks, audits };
  });
}

/** 目标账号看审批实例（真实授权器：目标不是参与人、也不是范围内管理员时 404）。 */
async function readAs(scene: Scene, userId: string) {
  const real = tenantApi(scene.db, { authorize: undefined, clock: () => CLOCK });
  const response = await real.request('GET', `${APV}/instances/${scene.instanceId}`, {
    user: userId,
    tenant: scene.tenantId,
  });
  return response.status;
}

type Action = readonly ['admin-transfer' | 'admin-intervene', Record<string, unknown>];
const ACTIONS: readonly Action[] = [
  ['admin-transfer', {}],
  ['admin-intervene', { kind: 'reassign' }],
];

function defineSuite(name: string, build: (label: string) => Promise<Scene>) {
  describe(`AC-APV（补）F-067 ${name}：管理员转交 / 改派目标须在操作人范围内`, () => {
    it('范围内实例转 / 改派给范围外员工、未绑定纯账号、不存在账号：错误完全相同，实例 / 待办 / 审计 / 目标可见性不变', async () => {
      const scene = await build(`f067-deny-${name}`);
      const call = scopedApi(scene);
      const before = await snapshotOf(scene);
      const outsideReadBefore = await readAs(scene, scene.outside.userId);
      for (const [path, extra] of ACTIONS) {
        const attempt = async (toUserId: string) => {
          const response = await call(path, scene.revision, {
            taskId: scene.taskId,
            toUserId,
            reason: '越权改派',
            ...extra,
          });
          return { status: response.status, body: await response.text() };
        };
        const outside = await attempt(scene.outside.userId);
        expect(outside.status, `${path}: ${outside.body}`).toBe(404);
        expect(await attempt(scene.plain), `${path} 未绑定纯账号（待产品确认，先按拒绝）`).toEqual(outside);
        expect(await attempt(MISSING_USER), `${path} 不存在的账号`).toEqual(outside);
      }
      expect(await snapshotOf(scene)).toEqual(before);
      expect(await readAs(scene, scene.outside.userId)).toBe(outsideReadBefore);
    });

    it('目标在操作人范围内：转交与改派成功，待办落到目标', async () => {
      for (const [path, extra] of ACTIONS) {
        const scene = await build(`f067-ok-${name}-${path}`);
        const response = await scopedApi(scene)(path, scene.revision, {
          taskId: scene.taskId,
          toUserId: scene.inside.userId,
          reason: '范围内改派',
          ...extra,
        });
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
        const after = await snapshotOf(scene);
        expect(after.tasks.filter((t) => t.status === 'pending').map((t) => t.assignee_user_id)).toEqual([
          scene.inside.userId,
        ]);
      }
    });

    it('转给操作人自己：不看目标范围（操作人本就看得到该实例），仍要求理由', async () => {
      const scene = await build(`f067-self-${name}`);
      const call = scopedApi(scene);
      const noReason = await call('admin-transfer', scene.revision, { taskId: scene.taskId, toUserId: scene.admin });
      expect(noReason.status).toBe(400);
      const done = await call('admin-transfer', scene.revision, {
        taskId: scene.taskId,
        toUserId: scene.admin,
        reason: '转给自己处理',
      });
      expect(done.status, await done.clone().text()).toBe(200);
    });

    it('跳转不指定目标人，不受目标范围校验影响', async () => {
      const scene = await build(`f067-jump-${name}`);
      const response = await scopedApi(scene)('admin-intervene', scene.revision, {
        kind: 'jump',
        toNodeKey: await firstNodeKey(scene),
        reason: '跳转',
      });
      // 目标范围校验不应介入：不会因范围返回目标不存在；其余业务失败（如节点不存在）不在本用例断言范围
      expect(await response.text()).not.toContain('转交目标不存在');
    });
  });
}

async function firstNodeKey(scene: Scene): Promise<string> {
  return withTenant(scene.db, scene.tenantId, async (tx) => {
    const [row] = rowsOf<{ node_key: string }>(
      await tx.execute(sql`SELECT node_key FROM approval_tasks WHERE instance_id=${scene.instanceId}::uuid
        ORDER BY seq LIMIT 1`),
    );
    return row!.node_key;
  });
}

// ---- 任职 --------------------------------------------------------------------------------------------------------
defineSuite('任职调动', async (label) => {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [NODES.outHead, NODES.inHrbp] });
  const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  const inside = await w.person('范围内目标', s.from);
  const outside = await w.person('范围外目标', s.to);
  return {
    db: w.db,
    tenantId: w.tenant.id,
    objectCode: EMPLOYMENT,
    subjectEmployeeId: s.subject.employeeId,
    instanceId: view.id,
    revision: view.revision,
    taskId: pendingOf(view)[0]!.id,
    admin: await w.member('范围管理员'),
    inside,
    outside,
    plain: await w.member('未绑定纯账号'),
  };
});

// ---- 员工子集变更 ------------------------------------------------------------------------------------------------
defineSuite('员工子集变更', async (label) => {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.json(
    await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school', 'major'] } },
    }),
  );
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school', 'major'] }],
  });
  const path = `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`;
  const record = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
    201,
  );
  const created = await w.json<{ id: string }>(
    await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
      ifMatch: 0,
      body: {
        employeeId: s.subject.employeeId,
        subset: 'education',
        recordId: record.id,
        targetRevision: record.revision,
        values: { school: '乙校' },
      },
    }),
    201,
  );
  const view = await w.instanceOf(created.id, s.subject.userId);
  const inside = await w.person('范围内目标', s.from);
  const outside = await w.person('范围外目标', s.to);
  return {
    db: w.db,
    tenantId: w.tenant.id,
    objectCode: EMPLOYMENT,
    subjectEmployeeId: s.subject.employeeId,
    instanceId: view.id,
    revision: view.revision,
    taskId: pendingOf(view)[0]!.id,
    admin: await w.member('范围管理员'),
    inside,
    outside,
    plain: await w.member('未绑定纯账号'),
  };
});

// ---- 合同 --------------------------------------------------------------------------------------------------------
defineSuite('合同', async (label) => {
  const w = await contractWorld(database().db, label);
  const tenantId = w.session.tenant.id;
  const reviewer = await createUser(
    w.db,
    { email: `review-${randomUUID()}@example.com`, displayName: '合成审批人' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId, userId: reviewer.id, expectedRevision: 0 }, cmd());
  await withTenant(w.db, tenantId, async (tx) => {
    for (const preset of PRESET_PROCESSES.filter((p) => p.approvalType.startsWith('contract_'))) {
      const ctx = {
        tenantId,
        userId: w.session.user.id,
        timezone: 'Asia/Shanghai',
        now: CLOCK,
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      const created = await createProcess(
        tx,
        ctx,
        { code: preset.code, approvalType: preset.approvalType },
        {
          ...preset.definition,
          exceptionAdminUserId: reviewer.id,
          nodes: [
            { ...preset.definition.nodes[0]!, kind: 'single', approver: 'owner', exits: ['approve', 'disagree'] },
          ],
        },
      );
      await publishProcess(tx, { ...ctx, expectedRevision: created.revision }, created.id);
    }
  });
  const original = await w.create();
  const applied = await w.request('POST', '/commands', {
    ifMatch: original.revision,
    body: {
      operation: 'change',
      mode: 'application',
      employeeId: w.employee.id,
      targetId: original.id,
      fields: { effectiveDate: '2025-03-01' },
    },
  });
  expect(applied.status, await applied.clone().text()).toBe(201);
  const [task] = await withTenant(w.db, tenantId, async (tx) =>
    rowsOf<{ id: string; instanceId: string; revision: number }>(
      await tx.execute(sql`SELECT t.id::text,t.instance_id::text AS "instanceId",i.revision FROM approval_tasks t
        JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
        WHERE t.status='pending' ORDER BY t.id`),
    ),
  );
  /** 目标：新建员工 + 账号 + 绑定（合同夹具没有现成的带账号人员）。 */
  const target = async (name: string): Promise<Target> => {
    const user = await createUser(w.db, { email: `t-${randomUUID()}@example.com`, displayName: name }, cmd());
    await grantMembership(w.db, { tenantId, userId: user.id, expectedRevision: 0 }, cmd());
    const employee = await w.session.employee();
    await withTenant(w.db, tenantId, (tx) =>
      tx.insert(permissionUserPersonLinks).values({ tenantId, userId: user.id, employeeId: employee.id }),
    );
    return { userId: user.id, employeeId: employee.id };
  };
  const adminUser = await createUser(
    w.db,
    { email: `adm-${randomUUID()}@example.com`, displayName: '范围管理员' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId, userId: adminUser.id, expectedRevision: 0 }, cmd());
  const plain = await createUser(w.db, { email: `plain-${randomUUID()}@example.com`, displayName: '纯账号' }, cmd());
  await grantMembership(w.db, { tenantId, userId: plain.id, expectedRevision: 0 }, cmd());
  return {
    db: w.db,
    tenantId,
    objectCode: CONTRACT_OBJECT,
    subjectEmployeeId: w.employee.id,
    instanceId: task!.instanceId,
    revision: task!.revision,
    taskId: task!.id,
    admin: adminUser.id,
    inside: await target('范围内目标'),
    outside: await target('范围外目标'),
    plain: plain.id,
  };
});

// ---- 发展计划 ----------------------------------------------------------------------------------------------------
defineSuite('发展计划', async (label) => {
  const w = await planWorld(database().db, label);
  const plan = await w.submit(await w.startedPlan(), 1, w.employee.userId);
  const view = await w.instanceOf(plan, 1);
  const inside = await w.person('范围内目标', w.dept);
  const outside = await w.person('范围外目标', await w.org('范围外部门'));
  return {
    db: w.db,
    tenantId: w.tenant.id,
    objectCode: IDP_PLAN,
    subjectEmployeeId: w.employee.employeeId,
    instanceId: view.id,
    revision: view.revision,
    taskId: view.tasks.find((t) => t.status === 'pending')!.id,
    admin: await w.member('范围管理员'),
    inside,
    outside,
    plain: await w.member('未绑定纯账号'),
  };
});

describe('AC-APV（补）F-067 既有规则无回归（范围内目标仍走 adminAct 的其余判定）', () => {
  it('范围内目标是同节点其他办理人 / 冻结主体回避：仍按原错误码拒绝，不被范围校验吞掉', async () => {
    const w = await approvalWorld(database().db, 'f067-regress');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ ...NODES.outHead, actions: { avoidSubjects: true } }, NODES.inHrbp] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const scene: Scene = {
      db: w.db,
      tenantId: w.tenant.id,
      objectCode: EMPLOYMENT,
      subjectEmployeeId: s.subject.employeeId,
      instanceId: view.id,
      revision: view.revision,
      taskId: pendingOf(view)[0]!.id,
      admin: await w.member('范围管理员'),
      inside: s.subject,
      outside: await w.person('范围外目标', s.to),
      plain: await w.member('未绑定纯账号'),
    };
    // 异动员工本人在范围内，但节点开启 avoidSubjects：由 adminAct 判定为目标回避（409 APPROVAL_SELF_REVIEW）
    const response = await scopedApi(scene)('admin-transfer', view.revision, {
      taskId: scene.taskId,
      toUserId: s.subject.userId,
      reason: '转给主体',
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('APPROVAL_SELF_REVIEW');
  });
});
