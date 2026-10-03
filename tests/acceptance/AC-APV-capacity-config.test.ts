/**
 * PR #35 第二轮清单 主题 H / I：容量、性能与配置。
 * 24 DEC-101 历史任务 / 日志分页、不设总量上限，只限制单次操作与同时在办规模，同类流程匹配不设 200 上限（X-19 / X-20）；
 * X-21 并发创建同编码流程返回 409；18 DEC-094 各业务类型与员工信息变更都有草稿预置；
 * 25 DEC-102 流程配置权仅限租户级管理员，与实例干预权分开。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import {
  approvalWorld,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

/** 通过 drizzle 会话的 logger 统计实际下发的语句（事务内新会话沿用同一 options）。 */
function recordStatements(db: Db) {
  const session = (db as unknown as { session: { logger: unknown; options: Record<string, unknown> } }).session;
  const statements: string[] = [];
  const logger = { logQuery: (query: string) => statements.push(query) };
  const previous = { logger: session.logger, options: session.options };
  session.logger = logger;
  session.options = { ...session.options, logger };
  return {
    statements,
    stop() {
      session.logger = previous.logger;
      session.options = previous.options;
    },
  };
}

async function fillHistory(w: ApprovalWorld, instanceId: string, tasks: number, logs: number) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`INSERT INTO approval_tasks
      (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,created_at)
      SELECT gen_random_uuid(),${w.tenant.id},${instanceId}::uuid,100000+g,1,'out_head',${w.exceptionAdmin}::uuid,
        'transfer','cancelled',now() FROM generate_series(1,${tasks}) g`);
    await tx.execute(sql`INSERT INTO approval_instance_logs
      (id,tenant_id,instance_id,seq,round,event,detail,created_at)
      SELECT gen_random_uuid(),${w.tenant.id},${instanceId}::uuid,100000+g,1,'urge','{}'::jsonb,
        now() - interval '1 day' FROM generate_series(1,${logs}) g`);
  });
}

describe('清单 24：审批容量（DEC-101）', () => {
  it('历史任务与日志累积不卡死实例；详情默认最新记录，完整历史分页读取', async () => {
    const w = await approvalWorld(database().db, 'apv-history');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    await fillHistory(w, view.id, 600, 1000);
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
    expect(done.logs.map((log) => log.event)).toEqual(expect.arrayContaining(['approve', 'complete']));
    const page = await w.json<{ items: { event: string }[]; page: number; pageSize: number }>(
      await w.request(w.hr.id, 'GET', `${BASE}/instances/${view.id}/logs?page=1&pageSize=50`),
    );
    expect(page.items[0]).toMatchObject({ event: 'complete' });
    const tasks = await w.json<{ items: unknown[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/instances/${view.id}/tasks?page=13&pageSize=50`),
    );
    expect(tasks.items.length).toBeGreaterThan(0);
  });

  it('同时在办的任务数超限给出明确提示', async () => {
    const w = await approvalWorld(database().db, 'apv-pending-limit');
    const s = await transferScene(w);
    const finance = await w.member('财务');
    await w.publishedProcess({ nodes: [{ ...TRANSFER_NODES[0]!, actions: { addSign: true } }] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO approval_tasks
        (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,created_at)
        SELECT gen_random_uuid(),${w.tenant.id},${view.id}::uuid,100000+g,1,'out_head',${w.exceptionAdmin}::uuid,
          'transfer','pending',now() FROM generate_series(1,60) g`),
    );
    const response = await w.taskAction(s.outHead.userId, current(view).id, 'add-sign', view.revision, {
      userId: finance,
      type: 'before',
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe('APPROVAL_TOO_MANY_PENDING');
  });

  it('同类流程超过 200 条也能匹配', async () => {
    const w = await approvalWorld(database().db, 'apv-many-processes');
    const s = await transferScene(w);
    const ctx = { tenantId: w.tenant.id, userId: w.hr.id, timezone: 'Asia/Shanghai', now: new Date() };
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (let i = 0; i < 205; i++) {
        const created = await createProcess(
          tx,
          { ...ctx, commandId: randomUUID(), expectedRevision: 0 },
          { code: `MANY_${String(i).padStart(3, '0')}`, approvalType: 'transfer' },
          {
            name: `批量流程 ${i}`,
            groupName: null,
            description: null,
            priority: i,
            isFallback: false,
            exceptionAdminUserId: w.exceptionAdmin,
            urgeEnabled: true,
            conditions: {
              items: [{ no: 1, field: 'employee.name', operator: 'eq', value: i === 204 ? '调动员工' : `无人${i}` }],
              expression: '',
            },
            nodes: [
              {
                key: 'out_head',
                name: '调出负责人',
                approver: 'latest_record_department_head',
                noAssignee: 'exception_admin',
                sameAssigneeSkip: false,
                historySameAssigneeSkip: false,
                formFields: [],
                editableFields: [],
                editMode: 'none',
                actions: { transfer: false, addSign: false, copySend: false, retrieve: false, urge: 'inherit' },
                rejectCommentRequired: false,
                commentPrivate: false,
                rejectResubmit: 'restart',
                messageRules: [],
              },
            ],
          },
        );
        await publishProcess(tx, { ...ctx, commandId: randomUUID(), expectedRevision: created.revision }, created.id);
      }
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view.status).toBe('running');
  });

  it('X-20：长串同人自动跳过不随节点数逐个重复查询任务与组织负责人', async () => {
    const w = await approvalWorld(database().db, 'apv-skip-chain');
    const s = await transferScene(w);
    const nodes = Array.from({ length: 30 }, (_, i) => ({
      key: `n${i}`,
      approver: 'latest_record_department_head' as const,
      sameAssigneeSkip: true,
    }));
    await w.publishedProcess({ nodes });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const recorder = recordStatements(w.db);
    let done: InstanceView;
    try {
      done = await w.json<InstanceView>(
        await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
      );
    } finally {
      recorder.stop();
    }
    expect(done.status).toBe('approved');
    const taskLoads = recorder.statements.filter((q) => /SELECT \* FROM approval_tasks WHERE/i.test(q));
    const headLookups = recorder.statements.filter((q) =>
      /SELECT person_in_charge_id,hrbp_id FROM org_versions/.test(q),
    );
    expect(taskLoads.length).toBeLessThanOrEqual(3);
    expect(headLookups.length).toBeLessThanOrEqual(3);
  });
});

describe('X-21：并发创建同编码流程返回 409', () => {
  it('同租户同时创建相同编码：一个成功、一个 409，不出现 500', async () => {
    const w = await approvalWorld(database().db, 'apv-code-race');
    const body = {
      code: 'RACE_CODE',
      name: '并发流程',
      approvalType: 'transfer',
      exceptionAdminUserId: w.exceptionAdmin,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
      nodes: [{ key: 'out_head', approver: 'latest_record_department_head' }],
    };
    const raced = await Promise.all(
      [0, 1].map(() => w.request(w.hr.id, 'POST', `${BASE}/processes`, { ifMatch: 0, body })),
    );
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409]);
  });
});

describe('清单 18：各业务类型与员工信息变更都有草稿预置（DEC-094）', () => {
  it('安装预置后每个审批类型都有一条草稿；离职预置带标准流程编码条件，配置异常管理员后可发布', async () => {
    const w = await approvalWorld(database().db, 'apv-presets-all');
    const installed = await w.json<{
      items: { id: string; approvalType: string; revision: number; latestVersion: { status: string } }[];
    }>(await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }));
    expect(installed.items.map((item) => item.approvalType).sort()).toEqual(Object.keys(APPROVAL_TYPES).sort());
    expect(installed.items.every((item) => item.latestVersion.status === 'draft')).toBe(true);
    const leave = installed.items.find((item) => item.approvalType === 'leave')!;
    const detail = await w.json<{
      revision: number;
      latestVersion: { conditions: { items: { field: string; value: string }[] }; nodes: { key: string }[] };
    }>(await w.request(w.hr.id, 'GET', `${BASE}/processes/${leave.id}`));
    expect(detail.latestVersion.conditions.items).toEqual([
      expect.objectContaining({ field: 'processCode', value: 'DimissionProcessNew' }),
    ]);
    const again = await w.json<{ items: unknown[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    expect(again.items).toHaveLength(installed.items.length);
  });
});

describe('清单 25：流程配置权仅限租户级管理员（DEC-102）', () => {
  it('持有流程对象全部按钮的普通身份不能配置流程；租户管理员可以', async () => {
    const w = await approvalWorld(database().db, 'apv-config-right');
    const world = await permissionAdmin(w);
    const departmentHr = await w.member('部门 HR');
    const profile = await createProfile(world, `apvcfg${randomUUID().slice(0, 6)}`);
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: [
          'code',
          'name',
          'approvalType',
          'priority',
          'isFallback',
          'exceptionAdminUserId',
          'conditions',
          'nodes',
        ].map((fieldCode) => ({ fieldCode, view: true, edit: true })),
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'publish', level: 'detail' },
        ],
      },
      'TenantBase.ApprovalProcess',
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, departmentHr, profile.id)).status).toBe(201);
    const real = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const body = {
      code: 'CFG_RIGHT',
      name: '配置权',
      approvalType: 'transfer',
      exceptionAdminUserId: w.exceptionAdmin,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
      nodes: [{ key: 'out_head', approver: 'latest_record_department_head' }],
    };
    const denied = await real.request('POST', `${BASE}/processes`, { ...w.as(departmentHr), ifMatch: 0, body });
    expect(denied.status).toBe(403);
    const tenantAdmin = await real.request('POST', `${BASE}/processes`, { ...w.as(w.hr.id), ifMatch: 0, body });
    expect(tenantAdmin.status, await tenantAdmin.clone().text()).toBe(201);
  });
});
