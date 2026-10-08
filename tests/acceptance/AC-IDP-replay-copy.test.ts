/**
 * R3-T07 PR-A 第 2 轮（Sol Ultra 第 1 轮审查 P2-1～P2-4，真实授权器）：
 * - P2-1 幂等重放按对象**当前**归属复核**当前可写性**：对象移到范围外 → 404；范围收紧到只能经向下公开查看 → 403；
 *   删除的重放按删除时的快照归属复核可写性（受控快照规则）；
 * - P2-2 重放同样复核首次执行时实际用到的嵌套写权限（子流程 create / update / delete 与父对象 subProcesses 字段）；
 * - P2-3 复制只能继承操作人看得到、且在目标位置有权创建的内容：有一项看不到或不能创建就整次拒绝（403），不生成副本；
 * - P2-4 复制同样校验节点配置：审批流程改版后旧节点不存在 → 409，不生成副本。
 * 负向用例都前后各读一次，证明业务数据未被改动。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  IDP_BASE,
  idpWorld,
  type ProcessView,
  republishApprovalProcess,
  subProcessBody,
  type TemplateView,
} from './AC-IDP-support.js';
import { clock, idpOperator, seedIdpData } from './AC-IDP-permission-support.js';

const testDb = useTestDb();

async function world() {
  const db = testDb().db;
  const base = await seedPermissionWorld(db);
  const w = { ...base, api: tenantApi(db, { authorize: undefined, clock }) };
  return { w, data: await seedIdpData(w) };
}

async function codeOf(response: Response) {
  const body = (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}

type World = Awaited<ReturnType<typeof world>>;

/** 管理员（全部允许）视角读写，用于移动对象与前后比对。 */
function admin({ w, data }: World) {
  const call = (method: string, path: string, extra: Parameters<typeof data.setup.request>[2] = {}) =>
    data.setup.request(method, `${IDP_BASE}${path}`, { ...w.asAdmin, ...extra });
  return {
    call,
    async read<T>(path: string): Promise<T> {
      const response = await call('GET', path);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as T;
    },
    async move(kind: 'processes' | 'templates', id: string, orgId: string) {
      const current = (await (await call('GET', `/${kind}/${id}`)).json()) as { revision: number };
      const response = await call('PATCH', `/${kind}/${id}`, { ifMatch: current.revision, body: { orgId } });
      expect(response.status, await response.clone().text()).toBe(200);
    },
    async templateNames() {
      const list = (await (await call('GET', '/templates?pageSize=200')).json()) as { items: TemplateView[] };
      return list.items.map((t) => t.name).sort();
    },
  };
}

const planApproval = (data: World['data']) => data.inside.process.subProcesses[0]!.approvalProcessId;

describe('P2-1 幂等重放按当前归属复核当前可写性', () => {
  it('流程新建后被移到范围外：原键重放 → 404，流程不变', async () => {
    const env = await world();
    const { w, data } = env;
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const body = { name: '将被移走的流程', orgId: data.insideOrg, subProcesses: [subProcessBody(planApproval(data))] };
    const first = await op.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-r2-move' });
    expect(first.status, await first.clone().text()).toBe(201);
    const id = ((await first.json()) as ProcessView).id;
    await admin(env).move('processes', id, data.outsideOrg);
    const before = await admin(env).read<ProcessView>(`/processes/${id}`);

    const replay = await op.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-r2-move' });
    expect(await codeOf(replay)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await admin(env).read<ProcessView>(`/processes/${id}`)).toEqual(before);
  });

  it('范围收紧到只能经向下公开查看：原键重放 → 403 IDP_PUBLIC_DOWN_READONLY', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const body = { name: '向下公开流程', orgId: data.insideOrg, subProcesses: [subProcessBody(planApproval(data))] };
    const first = await op.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-r2-narrow' });
    expect(first.status, await first.clone().text()).toBe(201);
    await op.setOrg(data.childOrg);
    const replay = await op.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-r2-narrow' });
    expect(await codeOf(replay)).toMatchObject({ status: 403, reason: 'IDP_PUBLIC_DOWN_READONLY' });
  });

  it('模板修改、模块新增、通用目标新增后模板被移走：原键重放都 → 404', async () => {
    const env = await world();
    const { w, data } = env;
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const template = data.inside.template;
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const patchBody = { name: '改名后的内模板' };
    const patched = await op.request('PATCH', `/templates/${template.id}`, {
      ifMatch: template.revision,
      body: patchBody,
      idempotencyKey: 'idp-r2-tpatch',
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const afterPatch = (await patched.json()) as TemplateView;
    const moduleBody = { moduleType: 'review', name: '中期回顾' };
    const added = await op.request('POST', `/templates/${template.id}/modules`, {
      ifMatch: afterPatch.revision,
      body: moduleBody,
      idempotencyKey: 'idp-r2-module',
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const afterModule = (await added.json()) as TemplateView;
    const goalBody = { moduleId: goal.id, name: '重放目标' };
    const goalAdded = await op.request('POST', `/templates/${template.id}/common-goals`, {
      ifMatch: afterModule.revision,
      body: goalBody,
      idempotencyKey: 'idp-r2-goal',
    });
    expect(goalAdded.status, await goalAdded.clone().text()).toBe(201);
    await admin(env).move('templates', template.id, data.outsideOrg);
    const before = await admin(env).read<TemplateView>(`/templates/${template.id}`);

    const replays = [
      op.request('PATCH', `/templates/${template.id}`, {
        ifMatch: template.revision,
        body: patchBody,
        idempotencyKey: 'idp-r2-tpatch',
      }),
      op.request('POST', `/templates/${template.id}/modules`, {
        ifMatch: afterPatch.revision,
        body: moduleBody,
        idempotencyKey: 'idp-r2-module',
      }),
      op.request('POST', `/templates/${template.id}/common-goals`, {
        ifMatch: afterModule.revision,
        body: goalBody,
        idempotencyKey: 'idp-r2-goal',
      }),
    ];
    for (const replay of await Promise.all(replays)) {
      expect(await codeOf(replay)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    expect(await admin(env).read<TemplateView>(`/templates/${template.id}`)).toEqual(before);
  });

  it('删除的重放按删除时快照的归属复核可写性：只能经向下公开查看 → 403，范围清空 → 404', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const created = await op.request('POST', '/templates', {
      ifMatch: 0,
      body: { name: '将被删除的模板', orgId: data.insideOrg, processId: data.inside.process.id },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const template = (await created.json()) as TemplateView;
    const del = () =>
      op.request('DELETE', `/templates/${template.id}`, { ifMatch: template.revision, idempotencyKey: 'idp-r2-del' });
    expect((await del()).status).toBe(200);
    await op.setOrg(data.childOrg);
    expect(await codeOf(await del())).toMatchObject({ status: 403, reason: 'IDP_PUBLIC_DOWN_READONLY' });
    await op.setOrg(null);
    expect(await codeOf(await del())).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('P2-2 重放复核嵌套写权限', () => {
  it('撤掉 IDP.SubProcess 写权限后：流程 POST、改子流程的 PATCH、删子流程的 PATCH 原键重放都 → 403', async () => {
    const env = await world();
    const { w, data } = env;
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const approval = planApproval(data);
    const postBody = { name: '嵌套重放流程', orgId: data.insideOrg, subProcesses: [subProcessBody(approval)] };
    const created = await op.request('POST', '/processes', {
      ifMatch: 0,
      body: postBody,
      idempotencyKey: 'idp-r2-nested-post',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const twoStages = await op.request('POST', '/processes', {
      ifMatch: 0,
      body: {
        name: '两段流程',
        orgId: data.insideOrg,
        subProcesses: [subProcessBody(approval), subProcessBody(approval, { name: '第二段', category: 'review' })],
      },
    });
    const process = (await twoStages.json()) as ProcessView;
    const input = process.subProcesses.map(({ ruleText: _r, ...rest }) => rest);
    const renameBody = { subProcesses: input.map((s, i) => (i === 1 ? { ...s, name: '改名的第二段' } : s)) };
    const renamed = await op.request('PATCH', `/processes/${process.id}`, {
      ifMatch: process.revision,
      body: renameBody,
      idempotencyKey: 'idp-r2-nested-rename',
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const afterRename = (await renamed.json()) as ProcessView;
    const dropBody = { subProcesses: afterRename.subProcesses.slice(0, 1).map(({ ruleText: _r, ...rest }) => rest) };
    const dropped = await op.request('PATCH', `/processes/${process.id}`, {
      ifMatch: afterRename.revision,
      body: dropBody,
      idempotencyKey: 'idp-r2-nested-drop',
    });
    expect(dropped.status, await dropped.clone().text()).toBe(200);
    const before = await admin(env).read<ProcessView>(`/processes/${process.id}`);

    await op.revokeWrite('subProcess');
    const replays = [
      op.request('POST', '/processes', { ifMatch: 0, body: postBody, idempotencyKey: 'idp-r2-nested-post' }),
      op.request('PATCH', `/processes/${process.id}`, {
        ifMatch: process.revision,
        body: renameBody,
        idempotencyKey: 'idp-r2-nested-rename',
      }),
      op.request('PATCH', `/processes/${process.id}`, {
        ifMatch: afterRename.revision,
        body: dropBody,
        idempotencyKey: 'idp-r2-nested-drop',
      }),
    ];
    for (const replay of await Promise.all(replays)) {
      expect(await codeOf(replay)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
    expect(await admin(env).read<ProcessView>(`/processes/${process.id}`)).toEqual(before);
  });
});

describe('P2-3 复制只继承看得到、且有权创建的内容（否则整次拒绝）', () => {
  it('看不到源模板描述：复制 → 403 IDP_COPY_HIDDEN_FIELDS，不生成副本', async () => {
    const env = await world();
    const { w, data } = env;
    const op = await idpOperator(w, { orgId: data.insideOrg, hidden: { template: ['description'] } });
    const before = await admin(env).templateNames();
    const response = await op.request('POST', `/templates/${data.inside.template.id}/copy`, {
      ifMatch: 0,
      body: { name: '偷描述的副本', orgId: data.childOrg },
    });
    expect(await codeOf(response)).toMatchObject({ status: 403, reason: 'IDP_COPY_HIDDEN_FIELDS' });
    expect(await admin(env).templateNames()).toEqual(before);
  });

  it('看不到源模块的说明或节点配置：复制 → 403，不生成副本', async () => {
    const env = await world();
    const { w, data } = env;
    for (const hidden of ['description', 'nodeSettings']) {
      const op = await idpOperator(w, { orgId: data.insideOrg, hidden: { templateModule: [hidden] } });
      const before = await admin(env).templateNames();
      const response = await op.request('POST', `/templates/${data.inside.template.id}/copy`, {
        ifMatch: 0,
        body: { name: `副本-${hidden}` },
      });
      expect(await codeOf(response), hidden).toMatchObject({ status: 403, reason: 'IDP_COPY_HIDDEN_FIELDS' });
      expect(await admin(env).templateNames()).toEqual(before);
    }
  });

  it('只授模板与流程对象（不能建模块与通用目标）：复制 → 403，不生成副本', async () => {
    const env = await world();
    const { w, data } = env;
    const op = await idpOperator(w, { orgId: data.insideOrg, objects: ['template', 'process', 'subProcess'] });
    const before = await admin(env).templateNames();
    const response = await op.request('POST', `/templates/${data.inside.template.id}/copy`, {
      ifMatch: 0,
      body: { name: '无模块权限的副本' },
    });
    expect(await codeOf(response)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await admin(env).templateNames()).toEqual(before);
  });

  it('全部看得到且有权创建：复制到下级组织 → 201，副本带出描述与模块', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const response = await op.request('POST', `/templates/${data.inside.template.id}/copy`, {
      ifMatch: 0,
      body: { name: '合规副本', orgId: data.childOrg },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const copy = (await response.json()) as TemplateView;
    expect(copy).toMatchObject({ name: '合规副本', orgId: data.childOrg, description: '内保密描述' });
    expect(copy.modules.map((m) => m.moduleType)).toEqual(['basic', 'goal']);
  });
});

describe('P2-4 复制校验节点配置', () => {
  it('审批流程改版后旧节点不存在：复制 → 409 IDP_NODE_NOT_FOUND，不生成副本', async () => {
    const w = await idpWorld(testDb().db, 'idpr2node');
    const process = await w.process();
    let template = await w.addModule(await w.template(process.id), { moduleType: 'goal', name: '发展目标' });
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const patched = await w.request('PATCH', `/templates/${template.id}/modules/${goal.id}`, {
      ifMatch: template.revision,
      body: {
        nodeSettings: [
          {
            subProcessId: process.subProcesses[0]!.id,
            nodeKey: 'set_goals',
            enabled: true,
            buttons: ['RowAddIdpGoal'],
          },
        ],
      },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    template = (await patched.json()) as TemplateView;
    await republishApprovalProcess(testDb().db, w.as, w.approvals.plan.id, 'idp_plan', [
      ['new_set_goals', '制定发展目标（新版）'],
      ['approve_plan', '审批发展计划'],
    ]);
    const before = await w.read<{ items: TemplateView[] }>('/templates');

    const response = await w.request('POST', `/templates/${template.id}/copy`, {
      ifMatch: 0,
      body: { name: '旧节点副本' },
    });
    expect(await codeOf(response)).toMatchObject({ status: 409, reason: 'IDP_NODE_NOT_FOUND' });
    expect(await w.read<{ items: TemplateView[] }>('/templates')).toEqual(before);
  });
});

describe('第 3 轮 P2：复制对通用目标的查看权判定不依赖来源集合是否为空', () => {
  /** 两个源模板：一个没有通用目标、一个有；其余相同（同组织、同流程、都有发展目标模块）。 */
  async function sources(env: World) {
    const { data } = env;
    const call = admin(env).call;
    const created = async (name: string) => {
      const response = await call('POST', '/templates', {
        ifMatch: 0,
        body: { name, orgId: data.insideOrg, processId: data.inside.process.id },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      let template = (await response.json()) as TemplateView;
      const added = await call('POST', `/templates/${template.id}/modules`, {
        ifMatch: template.revision,
        body: { moduleType: 'goal', name: '发展目标' },
      });
      template = (await added.json()) as TemplateView;
      return template;
    };
    const empty = await created('无通用目标的源模板');
    let withGoal = await created('有通用目标的源模板');
    const goal = withGoal.modules.find((m) => m.moduleType === 'goal')!;
    const added = await call('POST', `/templates/${withGoal.id}/common-goals`, {
      ifMatch: withGoal.revision,
      body: { moduleId: goal.id, name: '隐藏的通用目标' },
    });
    expect(added.status, await added.clone().text()).toBe(201);
    withGoal = (await added.json()) as TemplateView;
    return { empty, withGoal };
  }

  const states = [
    ['看不到模板的 commonGoals 字段', { hidden: { template: ['commonGoals'] } }],
    [
      '看得到父字段、没有通用目标对象的查看权',
      { objects: ['process', 'subProcess', 'template', 'templateModule'] as const },
    ],
  ] as const;

  it.each(states)(
    '%s：来源为空与非空同样 403 IDP_COPY_HIDDEN_FIELDS，响应体完全一致，不生成副本',
    async (_label, options) => {
      const env = await world();
      const { w, data } = env;
      const { empty, withGoal } = await sources(env);
      const op = await idpOperator(w, { orgId: data.insideOrg, ...options });
      const before = await admin(env).templateNames();
      const copy = async (source: TemplateView, name: string) => {
        const response = await op.request('POST', `/templates/${source.id}/copy`, { ifMatch: 0, body: { name } });
        return { status: response.status, body: await response.json() };
      };
      const fromEmpty = await copy(empty, '空来源副本');
      const fromGoal = await copy(withGoal, '非空来源副本');
      expect(fromEmpty.status).toBe(403);
      expect(fromEmpty.body).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'IDP_COPY_HIDDEN_FIELDS' } },
      });
      expect(fromGoal).toEqual(fromEmpty);
      expect(await admin(env).templateNames()).toEqual(before);
    },
  );
});

describe('第 3 轮同类实例：复制对模块字段的查看权判定不依赖来源模块的类型', () => {
  it('看不到模块的 nodeSettings：只有基本信息模块的来源与带发展目标模块的来源同样 403，响应体一致', async () => {
    const env = await world();
    const { w, data } = env;
    const call = admin(env).call;
    const created = await call('POST', '/templates', {
      ifMatch: 0,
      body: { name: '只有基本信息的源模板', orgId: data.insideOrg, processId: data.inside.process.id },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const basicOnly = (await created.json()) as TemplateView;
    const op = await idpOperator(w, { orgId: data.insideOrg, hidden: { templateModule: ['nodeSettings'] } });
    const before = await admin(env).templateNames();
    const copy = async (source: TemplateView, name: string) => {
      const response = await op.request('POST', `/templates/${source.id}/copy`, { ifMatch: 0, body: { name } });
      return { status: response.status, body: await response.json() };
    };
    const fromBasic = await copy(basicOnly, '基本信息来源副本');
    const fromGoal = await copy(data.inside.template, '目标模块来源副本');
    expect(fromBasic.status).toBe(403);
    expect(fromBasic.body).toMatchObject({ error: { details: { reason: 'IDP_COPY_HIDDEN_FIELDS' } } });
    expect(fromGoal).toEqual(fromBasic);
    expect(await admin(env).templateNames()).toEqual(before);
  });
});
