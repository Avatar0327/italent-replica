/**
 * PR-A 合并时未定的边界（DEC-309④，PR 描述第四节），真实授权器：
 * ④-1 ruleText 与 fixedDate 同一字段权限：看不到 fixedDate 就看不到 ruleText；ruleText 不是可单独授权的字段；
 * ④-2 父对象重排 / 级联删除须校验子对象权限：缺子对象权限整次拒绝（403）、不部分生效；不论子对象是否存在都要求；
 *      重放同样复核；
 * ④-3 审批流程废弃后：已引用的配置照常保存；发布成功但给提示；阶段开启失败（明确错误码）。
 * 负向用例前后各读一次，证明数据未变。
 */
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { IDP_BASE, type ProcessView, subProcessBody, type TemplateView } from './AC-IDP-support.js';
import { clock, idpOperator, seedIdpData } from './AC-IDP-permission-support.js';
import { planWorld, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

async function world() {
  const db = testDb().db;
  const base = await seedPermissionWorld(db);
  const w = { ...base, api: tenantApi(db, { authorize: undefined, clock }) };
  const data = await seedIdpData(w);
  const call = (method: string, path: string, extra: Parameters<typeof data.setup.request>[2] = {}) =>
    data.setup.request(method, `${IDP_BASE}${path}`, { ...w.asAdmin, ...extra });
  const read = async <T>(path: string): Promise<T> => {
    const response = await call('GET', path);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  };
  return { w, data, call, read };
}

describe('④-1 ruleText 与 fixedDate 同一字段权限', () => {
  it('ruleText 不是子流程对象上可单独授权的字段', () => {
    expect(IDP_OBJECTS.subProcess.fields.map((f) => f.code)).not.toContain('ruleText');
  });

  it('看不到 fixedDate：子流程里 fixedDate 与 ruleText 都缺席；看得到时 ruleText 照常输出', async () => {
    const { w, data, call } = await world();
    const approval = data.inside.process.subProcesses[0]!.approvalProcessId;
    const created = await call('POST', '/processes', {
      ifMatch: 0,
      body: {
        name: '固定日期流程',
        orgId: data.insideOrg,
        subProcesses: [subProcessBody(approval, { startTimeType: 'fixed', fixedDate: '2026-11-15' })],
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const id = ((await created.json()) as ProcessView).id;
    const hidden = await idpOperator(w, { orgId: data.insideOrg, hidden: { subProcess: ['fixedDate'] } });
    const view = (await (await hidden.request('GET', `/processes/${id}`)).json()) as ProcessView;
    expect(view.subProcesses[0]).not.toHaveProperty('fixedDate');
    expect(view.subProcesses[0]).not.toHaveProperty('ruleText');
    expect(JSON.stringify(view)).not.toContain('2026-11-15');
    const full = await idpOperator(w, { orgId: data.insideOrg });
    const shown = (await (await full.request('GET', `/processes/${id}`)).json()) as ProcessView;
    expect(shown.subProcesses[0]).toMatchObject({ fixedDate: '2026-11-15', ruleText: '于2026-11-15的凌晨2点自动开启' });
  });
});

describe('④-2 父对象重排 / 级联删除校验子对象权限', () => {
  async function freshProcess(env: Awaited<ReturnType<typeof world>>) {
    const approval = env.data.inside.process.subProcesses[0]!.approvalProcessId;
    const response = await env.call('POST', '/processes', {
      ifMatch: 0,
      body: {
        name: '未被引用的两段流程',
        orgId: env.data.insideOrg,
        subProcesses: [subProcessBody(approval, { name: '第一段' }), subProcessBody(approval, { name: '第二段' })],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ProcessView;
  }

  it('没有子流程编辑权：重排子流程 403，顺序不变', async () => {
    const env = await world();
    const process = await freshProcess(env);
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    await op.revokeWrite('subProcess');
    const reversed = [...process.subProcesses].reverse().map(({ ruleText: _r, ...sub }) => sub);
    const response = await op.request('PATCH', `/processes/${process.id}`, {
      ifMatch: process.revision,
      body: { subProcesses: reversed },
    });
    expect(response.status).toBe(403);
    expect(await env.read<ProcessView>(`/processes/${process.id}`)).toEqual(process);
  });

  it('没有子流程删除权：删除流程 403，流程与子流程都还在', async () => {
    const env = await world();
    const process = await freshProcess(env);
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    await op.revokeWrite('subProcess');
    const response = await op.request('DELETE', `/processes/${process.id}`, { ifMatch: process.revision });
    expect(response.status).toBe(403);
    expect(await env.read<ProcessView>(`/processes/${process.id}`)).toEqual(process);
  });

  it('删除模板：缺模块或通用目标的删除权 403（模板没有通用目标时同样要求）', async () => {
    for (const child of ['templateModule', 'commonGoal'] as const) {
      const env = await world();
      const template = env.data.inside.template;
      expect(template.commonGoals).toEqual([]);
      const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
      await op.revokeWrite(child);
      const before = await env.read<TemplateView>(`/templates/${template.id}`);
      const response = await op.request('DELETE', `/templates/${template.id}`, { ifMatch: before.revision });
      expect(response.status, child).toBe(403);
      expect(await env.read<TemplateView>(`/templates/${template.id}`)).toEqual(before);
    }
  });

  it('删除发展目标模块：缺通用目标删除权 403', async () => {
    const env = await world();
    const before = await env.read<TemplateView>(`/templates/${env.data.inside.template.id}`);
    const goalModule = before.modules.find((m) => m.moduleType === 'goal')!;
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    await op.revokeWrite('commonGoal');
    const response = await op.request('DELETE', `/templates/${before.id}/modules/${goalModule.id}`, {
      ifMatch: before.revision,
    });
    expect(response.status).toBe(403);
    expect(await env.read<TemplateView>(`/templates/${before.id}`)).toEqual(before);
  });

  it('删除流程成功后撤掉子流程删除权：原键重放 403', async () => {
    const env = await world();
    const process = await freshProcess(env);
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    const key = 'idp-b-cascade-replay';
    const first = await op.request('DELETE', `/processes/${process.id}`, {
      ifMatch: process.revision,
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    await op.revokeWrite('subProcess');
    const replay = await op.request('DELETE', `/processes/${process.id}`, {
      ifMatch: process.revision,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(403);
  });
});

describe('④-3 审批流程废弃后', () => {
  it('已引用的配置照常保存；发布成功但返回提示；计划开始时阶段开启失败（IDP_APPROVAL_PROCESS_UNAVAILABLE）', async () => {
    const w = await planWorld(testDb().db, 'idp-b-discard');
    const approval = await w.ok<{ revision: number }>(
      await w.http(w.hrUser, 'GET', `/api/tenant/approval/processes/${w.approvals.plan}`),
    );
    await w.ok(
      await w.http(w.hrUser, 'POST', `/api/tenant/approval/processes/${w.approvals.plan}/discard`, {
        ifMatch: approval.revision,
      }),
    );
    // 流程改名（不动引用）与模块节点配置照常保存
    const renamed = await w.http(w.hrUser, 'PATCH', `${IDP_BASE}/processes/${w.process.id}`, {
      ifMatch: w.process.revision,
      body: { name: '改过名的流程' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const unpublished = await w.ok<TemplateView>(
      await w.http(w.hrUser, 'POST', `${IDP_BASE}/templates/${w.template.id}/unpublish`, {
        ifMatch: w.template.revision,
      }),
    );
    const patched = await w.http(
      w.hrUser,
      'PATCH',
      `${IDP_BASE}/templates/${w.template.id}/modules/${w.goalModule.id}`,
      {
        ifMatch: unpublished.revision,
        body: {
          nodeSettings: [
            { subProcessId: w.stageId(1), nodeKey: 'set_goals', enabled: true, buttons: ['RowAddIdpGoal'] },
          ],
        },
      },
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    const saved = (await patched.json()) as TemplateView;
    // 发布：成功，带提示
    const published = await w.http(w.hrUser, 'POST', `${IDP_BASE}/templates/${w.template.id}/publish`, {
      ifMatch: saved.revision,
    });
    expect(published.status, await published.clone().text()).toBe(200);
    const body = (await published.json()) as TemplateView & { warnings?: { code: string; subProcessId: string }[] };
    expect(body.status).toBe('published');
    expect(body.warnings).toEqual([{ code: 'IDP_APPROVAL_PROCESS_DISCARDED', subProcessId: w.stageId(1) }]);

    // 开启：失败，记明确错误码
    const plan = await w.startedPlan();
    expect(plan.stages[0]).toMatchObject({
      status: 'failed',
      failureReason: 'IDP_APPROVAL_PROCESS_UNAVAILABLE',
      approvalInstanceId: null,
    });
    const retry = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    expect(retry.receipts[0]).toMatchObject({ status: 409, code: 'IDP_APPROVAL_PROCESS_UNAVAILABLE' });
  });

  it('未废弃时发布不带提示', async () => {
    const w = await planWorld(testDb().db, 'idp-b-nodiscard');
    const unpublished = await w.ok<TemplateView>(
      await w.http(w.hrUser, 'POST', `${IDP_BASE}/templates/${w.template.id}/unpublish`, {
        ifMatch: w.template.revision,
      }),
    );
    const published = await w.ok<{ warnings?: unknown[] }>(
      await w.http(w.hrUser, 'POST', `${IDP_BASE}/templates/${w.template.id}/publish`, {
        ifMatch: unpublished.revision,
      }),
    );
    expect(published.warnings ?? []).toEqual([]);
  });
});
