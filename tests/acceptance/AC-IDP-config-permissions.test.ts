/**
 * R3-T07 PR-A 权限矩阵（PR 描述“查看人 × 接口 × 字段”配置部分；AGENTS §10「权限」、DEC-043 / 080 / 216 / 285⑤）：
 * - 功能权限：无 IDP 对象权限 403；无按钮 403；字段不可编辑（含显式清空）403；前后读比对数据未变；
 * - 数据范围（用户 × IDP 应用，缺省空）：流程 / 模板按所属组织；向下公开的，范围内含其下级组织的 HR 可查看与选用，
 *   不能修改（403）；范围外与不存在同为 404；幂等重放按当前范围复核；
 * - 字段裁剪：顶层（流程 / 模板）与嵌套层（子流程 / 模块 / 通用目标）各按本对象字段权限；
 * - 审计：写入同事务记数据变更日志，审计查询按 IDP 对象权限、范围与字段权限裁剪。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { addMember } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { IDP_NOW, type ProcessView, subProcessBody, type TemplateView } from './AC-IDP-support.js';
import { clock, idpOperator, seedIdpData } from './AC-IDP-permission-support.js';

const testDb = useTestDb();

async function world() {
  const db = testDb().db;
  const base = await seedPermissionWorld(db);
  const w = { ...base, api: tenantApi(db, { authorize: undefined, clock }) };
  return { w, data: await seedIdpData(w) };
}

async function codeOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error.code, reason: body.error.details?.reason };
}

describe('配置接口：功能权限与数据范围', () => {
  it('没有 IDP 对象权限的成员（普通员工）：列表与详情 403', async () => {
    const { w, data } = await world();
    const member = await addMember(w, 'idp-plain');
    const as = { user: member.id, tenant: w.tenant.id };
    for (const path of ['/processes', `/processes/${data.inside.process.id}`, '/templates', '/approval-processes']) {
      const response = await w.api.request('GET', `/api/tenant/idp${path}`, as);
      expect(response.status, path).toBe(403);
    }
  });

  it('有对象权限但范围缺省为空：列表为空、详情 404', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w);
    const list = await op.request('GET', '/processes');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [], hasDataPermission: false });
    expect((await op.request('GET', `/templates/${data.inside.template.id}`)).status).toBe(404);
  });

  it('范围内 HR：看到范围内的流程与模板（实际值），范围外 404，列表不出现', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const processes = (await (await op.request('GET', '/processes')).json()) as { items: ProcessView[] };
    expect(processes.items.map((p) => p.name).sort()).toEqual(['内不公开流程', '内流程']);
    const detail = (await (await op.request('GET', `/templates/${data.inside.template.id}`)).json()) as TemplateView;
    expect(detail).toMatchObject({ name: '内模板', description: '内保密描述', orgId: data.insideOrg });
    for (const path of [`/processes/${data.outside.process.id}`, `/templates/${data.outside.template.id}`]) {
      const response = await op.request('GET', path);
      expect(await codeOf(response), path).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });

  it('范围外 HR 写入范围外对象 → 404，数据不变', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const before = await data.setup.request('GET', `/api/tenant/idp/templates/${data.outside.template.id}`, w.asAdmin);
    const beforeBody = await before.json();
    const attempts = [
      op.request('PATCH', `/templates/${data.outside.template.id}`, {
        ifMatch: data.outside.template.revision,
        body: { name: '越权改名' },
      }),
      op.request('POST', `/templates/${data.outside.template.id}/modules`, {
        ifMatch: data.outside.template.revision,
        body: { moduleType: 'review', name: '越权模块' },
      }),
      op.request('DELETE', `/templates/${data.outside.template.id}`, { ifMatch: data.outside.template.revision }),
      op.request('POST', '/templates', {
        ifMatch: 0,
        body: { name: '挂在范围外', orgId: data.outsideOrg, processId: data.inside.process.id },
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(await codeOf(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    const after = await data.setup.request('GET', `/api/tenant/idp/templates/${data.outside.template.id}`, w.asAdmin);
    expect(await after.json()).toEqual(beforeBody);
  });

  it('向下公开：下级组织的 HR 可查看与选用上级组织的流程 / 模板，不能修改（403）；不公开的看不到（404）', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.childOrg });
    const processes = (await (await op.request('GET', '/processes')).json()) as { items: ProcessView[] };
    expect(processes.items.map((p) => p.name)).toEqual(['内流程']);
    expect((await op.request('GET', `/processes/${data.closed.process.id}`)).status).toBe(404);
    expect((await op.request('GET', `/templates/${data.closed.template.id}`)).status).toBe(404);

    const patch = await op.request('PATCH', `/processes/${data.inside.process.id}`, {
      ifMatch: data.inside.process.revision,
      body: { name: '下级改上级' },
    });
    expect(await codeOf(patch)).toMatchObject({ status: 403, code: 'FORBIDDEN', reason: 'IDP_PUBLIC_DOWN_READONLY' });
    // 选用：在自己范围内的组织下新建模板，引用上级向下公开的流程
    const created = await op.request('POST', '/templates', {
      ifMatch: 0,
      body: { name: '下级模板', orgId: data.childOrg, processId: data.inside.process.id },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    // 不公开的流程不能选用（与不存在同为 404）
    const closed = await op.request('POST', '/templates', {
      ifMatch: 0,
      body: { name: '下级模板2', orgId: data.childOrg, processId: data.closed.process.id },
    });
    expect(await codeOf(closed)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const unchanged = await data.setup.request('GET', `/api/tenant/idp/processes/${data.inside.process.id}`, w.asAdmin);
    expect(((await unchanged.json()) as ProcessView).name).toBe('内流程');
  });

  it('没有按钮权限：新建 / 修改 / 删除 / 复制 / 发布 403，数据不变', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg, buttons: false });
    const template = data.inside.template;
    const attempts = [
      op.request('POST', '/processes', {
        ifMatch: 0,
        body: { name: '无按钮', orgId: data.insideOrg, subProcesses: [] },
      }),
      op.request('PATCH', `/templates/${template.id}`, { ifMatch: template.revision, body: { name: '无按钮改名' } }),
      op.request('DELETE', `/templates/${template.id}`, { ifMatch: template.revision }),
      op.request('POST', `/templates/${template.id}/copy`, { ifMatch: 0, body: { name: '无按钮复制' } }),
      op.request('POST', `/templates/${template.id}/publish`, { ifMatch: template.revision }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(await codeOf(response)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
    const after = (await (await op.request('GET', `/templates/${template.id}`)).json()) as TemplateView;
    expect(after).toEqual(template);
  });
});

describe('配置接口：字段裁剪与字段编辑权', () => {
  it('顶层与嵌套层分别按对象字段权限裁剪（核对允许字段的实际值与被裁剪字段的缺席）', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, {
      orgId: data.insideOrg,
      hidden: {
        template: ['description'],
        templateModule: ['description'],
        subProcess: ['days', 'approvalProcessId'],
        process: ['publicDown'],
      },
    });
    const template = (await (await op.request('GET', `/templates/${data.inside.template.id}`)).json()) as Record<
      string,
      unknown
    > & { modules: Record<string, unknown>[] };
    expect(template).toMatchObject({ name: '内模板', orgId: data.insideOrg });
    expect(template).not.toHaveProperty('description');
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    expect(goal).toMatchObject({ name: '内目标' });
    expect(goal).not.toHaveProperty('description');
    const list = (await (await op.request('GET', '/templates')).json()) as { items: Record<string, unknown>[] };
    for (const item of list.items) expect(item).not.toHaveProperty('description');

    const process = (await (await op.request('GET', `/processes/${data.inside.process.id}`)).json()) as Record<
      string,
      unknown
    > & { subProcesses: Record<string, unknown>[] };
    expect(process).toMatchObject({ name: '内流程' });
    expect(process).not.toHaveProperty('publicDown');
    expect(process.subProcesses[0]).toMatchObject({ name: '制定计划', startMode: 'auto' });
    expect(process.subProcesses[0]).not.toHaveProperty('days');
    expect(process.subProcesses[0]).not.toHaveProperty('approvalProcessId');
  });

  it('不可编辑字段：赋值与显式清空都 403，数据不变；嵌套字段同样校验', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, {
      orgId: data.insideOrg,
      readonly: { template: ['description'], templateModule: ['checkNoneGoal'], subProcess: ['name'] },
    });
    const template = data.inside.template;
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const process = data.inside.process;
    const attempts = [
      op.request('PATCH', `/templates/${template.id}`, { ifMatch: template.revision, body: { description: '改' } }),
      op.request('PATCH', `/templates/${template.id}`, { ifMatch: template.revision, body: { description: null } }),
      op.request('PATCH', `/templates/${template.id}/modules/${goal.id}`, {
        ifMatch: template.revision,
        body: { checkNoneGoal: true },
      }),
      op.request('PATCH', `/processes/${process.id}`, {
        ifMatch: process.revision,
        body: {
          subProcesses: process.subProcesses.map(({ ruleText: _r, ...sub }) => ({ ...sub, name: '改名' })),
        },
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(await codeOf(response)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
    expect(await (await op.request('GET', `/templates/${template.id}`)).json()).toEqual(template);
    const processAfter = (await (await op.request('GET', `/processes/${process.id}`)).json()) as ProcessView;
    expect(processAfter.subProcesses[0]!.name).toBe('制定计划');
  });
});

describe('幂等重放按当前范围复核', () => {
  it('撤销范围后重放同一命令 → 404，不返回原结果', async () => {
    const { w, data } = await world();
    const op = await idpOperator(w, { orgId: data.insideOrg });
    const body = {
      name: '重放流程',
      orgId: data.insideOrg,
      subProcesses: [subProcessBody(data.inside.process.subProcesses[0]!.approvalProcessId)],
    };
    const first = await op.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-replay-1' });
    expect(first.status, await first.clone().text()).toBe(201);
    await op.setOrg(null);
    const replay = await op.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-replay-1' });
    expect(await codeOf(replay)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('审计（DEC-216）', () => {
  it('流程 / 子流程 / 模板 / 模块 / 通用目标的写入都记数据变更日志；查询按 IDP 对象权限与范围裁剪', async () => {
    const { w, data } = await world();
    const audit = auditApi(w.db, IDP_NOW.toISOString(), { authorize: undefined });
    const template = data.inside.template;
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const added = await data.setup.request('POST', `/api/tenant/idp/templates/${template.id}/common-goals`, {
      ...w.asAdmin,
      ifMatch: template.revision,
      body: { moduleId: goal.id, name: '审计目标' },
    });
    expect(added.status, await added.clone().text()).toBe(201);

    const types = [
      IDP_OBJECTS.process.code,
      IDP_OBJECTS.template.code,
      IDP_OBJECTS.templateModule.code,
      IDP_OBJECTS.commonGoal.code,
    ];
    for (const objectType of types) {
      const { items } = await audit.dataChanges(w.asAdmin, { objectType, limit: '50' });
      expect(items.length, objectType).toBeGreaterThan(0);
      for (const item of items) expect(item.app).toBe('个人发展计划');
    }

    const viewer = await memberWithAdminRole(w, 'audit_admin', `idp-audit-${randomUUID().slice(0, 4)}`);
    const query = { objectType: IDP_OBJECTS.template.code, limit: '50' };
    expect((await audit.dataChanges(viewer.as, query)).items).toEqual([]);
    // 授予 IDP 身份但范围缺省为空：仍看不到
    const op = await idpOperator(w, { hidden: { template: ['description'] }, user: viewer.user });
    expect((await audit.dataChanges(op.as, query)).items).toEqual([]);
    await op.setOrg(data.insideOrg);
    const { items } = await audit.dataChanges(op.as, query);
    const ids = new Set(items.map((item) => item.objectId));
    expect(ids.has(data.inside.template.id)).toBe(true);
    expect(ids.has(data.outside.template.id)).toBe(false);
    const created = items.find((item) => item.operation === 'create' && item.objectId === template.id)!;
    const detail = await audit.dataChange(op.as, created.id);
    expect(detail.after).toMatchObject({ name: '内模板' });
    expect(JSON.stringify(detail)).not.toContain('内保密描述');
  });
});
