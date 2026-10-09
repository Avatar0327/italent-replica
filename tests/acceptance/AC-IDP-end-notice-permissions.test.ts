/**
 * F-047：子流程结束通知模板配置沿用 IDP 配置权限（规格 28 §1；DEC-309④、DEC-216）。
 * 字段裁剪覆盖流程列表、详情与审计；显式清空、幂等重放按当前字段权 / 按钮 / 范围复核。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS, SUB_PROCESS_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { clock, idpOperator, seedIdpData } from './AC-IDP-permission-support.js';
import { IDP_BASE, IDP_NOW, type ProcessView, subProcessBody } from './AC-IDP-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const TEMPLATE = 'IDP_STAGE_END_NOTICE';
const STAGE_NAME = '通知配置后的制定计划';
type NoticeProcess = Omit<ProcessView, 'subProcesses'> & {
  subProcesses: (ProcessView['subProcesses'][number] & { endNoticeTemplate: string | null })[];
};

async function world() {
  const base = await seedPermissionWorld(testDb().db);
  const w = { ...base, api: tenantApi(base.db, { authorize: undefined, clock }) };
  const data = await seedIdpData(w);
  const process = data.inside.process;
  const response = await data.setup.request('PATCH', `${IDP_BASE}/processes/${process.id}`, {
    ...w.asAdmin,
    ifMatch: process.revision,
    body: {
      subProcesses: process.subProcesses.map(({ ruleText: _rule, ...sub }) => ({
        ...sub,
        name: STAGE_NAME,
        endNoticeTemplate: TEMPLATE,
      })),
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const configured = (await response.json()) as NoticeProcess;
  return { w, data, process: configured };
}

type World = Awaited<ReturnType<typeof world>>;

async function adminRead(env: World): Promise<NoticeProcess> {
  const response = await env.data.setup.request('GET', `${IDP_BASE}/processes/${env.process.id}`, env.w.asAdmin);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as NoticeProcess;
}

function noticeBody(process: NoticeProcess, value: string | null) {
  return {
    subProcesses: process.subProcesses.map(({ ruleText: _rule, ...sub }) => ({ ...sub, endNoticeTemplate: value })),
  };
}

const guesses = {
  name: '另一子流程名称',
  category: 'review',
  approvalType: 'idp_mid_review',
  approvalProcessId: randomUUID(),
  endNoticeTemplate: 'IDP_WRONG_END_NOTICE',
  startMode: 'manual',
  startTimeType: 'fixed',
  fixedDate: '2026-11-01',
  referencePoint: 'plan_start',
  startFrom: 'before',
  days: 1,
} as const;

function guessedBody(process: NoticeProcess, field: keyof typeof guesses, value: unknown) {
  return {
    subProcesses: process.subProcesses.map(({ ruleText: _rule, ...sub }) => ({ ...sub, [field]: value })),
  };
}

async function codeOf(response: Response) {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

async function auditLogs(env: World) {
  return (
    await auditApi(env.w.db, IDP_NOW.toISOString()).dataChanges(env.w.asAdmin, {
      objectType: IDP_OBJECTS.subProcess.code,
      limit: '100',
    })
  ).items;
}

describe('AC-IDP（补）F-047：结束通知模板配置权限', () => {
  it.each(SUB_PROCESS_FIELDS)('隐藏 %s：猜中、猜错、合法清空及重复请求均同样拒绝，不能探测原值', async (field) => {
    const env = await world();
    const op = await idpOperator(env.w, {
      orgId: env.data.insideOrg,
      hidden: { subProcess: [field] },
    });
    const before = await adminRead(env);
    const logs = await auditLogs(env);
    const same = before.subProcesses[0]![field];
    const values = [same, guesses[field]];
    if (field === 'endNoticeTemplate' || same === null) values.push(null);
    let rejection: unknown;
    for (const value of values) {
      const options = {
        ifMatch: before.revision,
        body: guessedBody(before, field, value),
        idempotencyKey: `idp-hidden-probe-${randomUUID()}`,
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await op.request('PATCH', `/processes/${before.id}`, options);
        const result = { status: response.status, body: await response.json() };
        expect(result).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
        rejection ??= result;
        expect(result).toEqual(rejection);
        expect(await adminRead(env)).toEqual(before);
        expect(await auditLogs(env)).toEqual(logs);
      }
    }
  });

  it.each(SUB_PROCESS_FIELDS)('显式提交可见 %s 的原值成功后隐藏：无变化命令原键重放也同样 403', async (field) => {
    const env = await world();
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    const options = {
      ifMatch: env.process.revision,
      body: guessedBody(env.process, field, env.process.subProcesses[0]![field]),
      idempotencyKey: `idp-hidden-noop-${randomUUID()}`,
    };
    const first = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await adminRead(env);
    const logs = await auditLogs(env);
    await op.hideFields('subProcess', [field]);
    const replay = await op.request('PATCH', `/processes/${before.id}`, options);
    const rejected = { status: replay.status, body: await replay.json() };
    expect(rejected).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
    const fresh = await op.request('PATCH', `/processes/${before.id}`, {
      ...options,
      ifMatch: before.revision,
      idempotencyKey: `idp-hidden-fresh-${randomUUID()}`,
    });
    expect({ status: fresh.status, body: await fresh.json() }).toEqual(rejected);
    expect(await adminRead(env)).toEqual(before);
    expect(await auditLogs(env)).toEqual(logs);
  });

  it('隐藏结束通知模板时省略该字段，仍能修改其他可见字段并保留原值', async () => {
    const env = await world();
    const op = await idpOperator(env.w, {
      orgId: env.data.insideOrg,
      hidden: { subProcess: ['endNoticeTemplate'] },
    });
    const response = await op.request('PATCH', `/processes/${env.process.id}`, {
      ifMatch: env.process.revision,
      body: {
        subProcesses: env.process.subProcesses.map(({ ruleText: _rule, endNoticeTemplate: _notice, ...sub }) => ({
          ...sub,
          name: '修改可见名称，保留隐藏模板',
        })),
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const shown = (await response.json()) as NoticeProcess;
    expect(shown.subProcesses[0]).toMatchObject({ name: '修改可见名称，保留隐藏模板' });
    expect(shown.subProcesses[0]).not.toHaveProperty('endNoticeTemplate');
    expect((await adminRead(env)).subProcesses[0]).toMatchObject({
      name: '修改可见名称，保留隐藏模板',
      endNoticeTemplate: TEMPLATE,
    });
  });

  it('可见只读的结束通知模板显式提交原值不要求编辑权，仍可修改其他字段', async () => {
    const env = await world();
    const op = await idpOperator(env.w, {
      orgId: env.data.insideOrg,
      readonly: { subProcess: ['endNoticeTemplate'] },
    });
    const body = noticeBody(env.process, TEMPLATE);
    body.subProcesses[0]!.name = '保留可见只读模板并修改名称';
    const response = await op.request('PATCH', `/processes/${env.process.id}`, {
      ifMatch: env.process.revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      subProcesses: [{ name: '保留可见只读模板并修改名称', endNoticeTemplate: TEMPLATE }],
    });
  });

  it('流程列表和详情：允许字段显示实际值，隐藏的嵌套结束通知模板不返回', async () => {
    const env = await world();
    const { w, data, process } = env;
    const allowed = await idpOperator(w, { orgId: data.insideOrg });
    const detail = await allowed.request('GET', `/processes/${process.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      name: '内流程',
      subProcesses: [{ name: STAGE_NAME, endNoticeTemplate: TEMPLATE }],
    });

    const hidden = await idpOperator(w, {
      orgId: data.insideOrg,
      hidden: { subProcess: ['endNoticeTemplate'] },
    });
    const hiddenDetail = await hidden.request('GET', `/processes/${process.id}`);
    expect(hiddenDetail.status).toBe(200);
    const shown = (await hiddenDetail.json()) as NoticeProcess;
    expect(shown).toMatchObject({ name: '内流程', orgId: data.insideOrg });
    expect(shown.subProcesses[0]).toMatchObject({ name: STAGE_NAME, startMode: 'auto' });
    expect(shown.subProcesses[0]).not.toHaveProperty('endNoticeTemplate');

    const response = await hidden.request('GET', '/processes');
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { items: NoticeProcess[] };
    const item = listed.items.find((candidate) => candidate.id === process.id)!;
    expect(item.subProcesses[0]).toMatchObject({ name: STAGE_NAME, startMode: 'auto' });
    expect(item.subProcesses[0]).not.toHaveProperty('endNoticeTemplate');
    expect(JSON.stringify(listed)).not.toContain(TEMPLATE);
  });

  it('结束通知模板只读：赋值和显式清空均 403，业务及变更日志不变', async () => {
    const env = await world();
    const op = await idpOperator(env.w, {
      orgId: env.data.insideOrg,
      readonly: { subProcess: ['endNoticeTemplate'] },
    });
    const before = await adminRead(env);
    const logs = await auditLogs(env);
    for (const value of ['IDP_FORBIDDEN_CHANGE', null]) {
      const response = await op.request('PATCH', `/processes/${before.id}`, {
        ifMatch: before.revision,
        body: noticeBody(before, value),
      });
      expect(await codeOf(response)).toEqual({ status: 403, code: 'FORBIDDEN' });
      expect(await adminRead(env)).toEqual(before);
      expect(await auditLogs(env)).toEqual(logs);
    }
  });

  it('无新字段编辑权时，创建显式填写 403，省略新字段仍能创建', async () => {
    const env = await world();
    const op = await idpOperator(env.w, {
      orgId: env.data.insideOrg,
      readonly: { subProcess: ['endNoticeTemplate'] },
    });
    const beforeResponse = await env.data.setup.request('GET', `${IDP_BASE}/processes`, env.w.asAdmin);
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json();
    const logs = await auditLogs(env);
    const sub = subProcessBody(env.process.subProcesses[0]!.approvalProcessId);
    const rejected = await op.request('POST', '/processes', {
      ifMatch: 0,
      body: {
        name: '无权限配置结束通知',
        orgId: env.data.insideOrg,
        subProcesses: [{ ...sub, endNoticeTemplate: TEMPLATE }],
      },
    });
    expect(await codeOf(rejected)).toEqual({ status: 403, code: 'FORBIDDEN' });
    const afterResponse = await env.data.setup.request('GET', `${IDP_BASE}/processes`, env.w.asAdmin);
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toEqual(before);
    expect(await auditLogs(env)).toEqual(logs);

    const created = await op.request('POST', '/processes', {
      ifMatch: 0,
      body: { name: '沿用旧字段的流程', orgId: env.data.insideOrg, subProcesses: [sub] },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await created.json()).toMatchObject({
      name: '沿用旧字段的流程',
      subProcesses: [{ endNoticeTemplate: null }],
    });
  });

  it('无新字段编辑权时，更新省略新字段保留原配置，只修改允许编辑的实际字段', async () => {
    const env = await world();
    const op = await idpOperator(env.w, {
      orgId: env.data.insideOrg,
      readonly: { subProcess: ['endNoticeTemplate'] },
    });
    const body = {
      subProcesses: env.process.subProcesses.map(({ ruleText: _rule, endNoticeTemplate: _notice, ...sub }) => ({
        ...sub,
        name: '调整节点名称，保留结束通知',
      })),
    };
    const response = await op.request('PATCH', `/processes/${env.process.id}`, {
      ifMatch: env.process.revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      subProcesses: [{ name: '调整节点名称，保留结束通知', endNoticeTemplate: TEMPLATE }],
    });
    expect((await adminRead(env)).subProcesses[0]).toMatchObject({
      name: '调整节点名称，保留结束通知',
      endNoticeTemplate: TEMPLATE,
    });
  });

  it('PATCH 成功后撤掉结束通知模板字段权：原键重放 403，不再次写入或返回旧字段', async () => {
    const env = await world();
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    const options = {
      ifMatch: env.process.revision,
      body: noticeBody(env.process, 'IDP_CHANGED_END_NOTICE'),
      idempotencyKey: `idp-end-field-${randomUUID()}`,
    };
    const first = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ subProcesses: [{ endNoticeTemplate: 'IDP_CHANGED_END_NOTICE' }] });
    const before = await adminRead(env);
    const logs = await auditLogs(env);
    await op.hideFields('subProcess', ['endNoticeTemplate']);
    const replay = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(await codeOf(replay)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await adminRead(env)).toEqual(before);
    expect(await auditLogs(env)).toEqual(logs);
  });

  it('PATCH 成功后清空 IDP 范围：原键重放 404，业务及变更日志不变', async () => {
    const env = await world();
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    const options = {
      ifMatch: env.process.revision,
      body: noticeBody(env.process, 'IDP_SCOPE_END_NOTICE'),
      idempotencyKey: `idp-end-scope-${randomUUID()}`,
    };
    const first = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await adminRead(env);
    const logs = await auditLogs(env);
    await op.setOrg(null);
    const replay = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(await codeOf(replay)).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await adminRead(env)).toEqual(before);
    expect(await auditLogs(env)).toEqual(logs);
  });

  it('PATCH 成功后撤掉流程编辑按钮：原键重放 403，业务及变更日志不变', async () => {
    const env = await world();
    const op = await idpOperator(env.w, { orgId: env.data.insideOrg });
    const options = {
      ifMatch: env.process.revision,
      body: noticeBody(env.process, 'IDP_BUTTON_END_NOTICE'),
      idempotencyKey: `idp-end-button-${randomUUID()}`,
    };
    const first = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(first.status, await first.clone().text()).toBe(200);
    const before = await adminRead(env);
    const logs = await auditLogs(env);
    await op.setButtons(false);
    const replay = await op.request('PATCH', `/processes/${env.process.id}`, options);
    expect(await codeOf(replay)).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await adminRead(env)).toEqual(before);
    expect(await auditLogs(env)).toEqual(logs);
  });

  it('审计保存结束通知模板的前后值，当前字段权裁剪列表、变化与详情快照', async () => {
    const env = await world();
    const full = auditApi(env.w.db, IDP_NOW.toISOString());
    const log = (await auditLogs(env)).find(
      (item) => item.objectId === env.process.subProcesses[0]!.id && item.operation === 'update',
    )!;
    expect(log.changes).toContainEqual(
      expect.objectContaining({ field: 'endNoticeTemplate', from: null, to: TEMPLATE }),
    );
    const detail = await full.dataChange(env.w.asAdmin, log.id);
    expect(detail.before).toMatchObject({ endNoticeTemplate: null });
    expect(detail.after).toMatchObject({ endNoticeTemplate: TEMPLATE, name: STAGE_NAME });

    const viewer = await memberWithAdminRole(env.w, 'audit_admin', `idp-end-audit-${randomUUID().slice(0, 8)}`);
    const op = await idpOperator(env.w, {
      user: viewer.user,
      orgId: env.data.insideOrg,
      hidden: { subProcess: ['endNoticeTemplate'] },
    });
    const audit = auditApi(env.w.db, IDP_NOW.toISOString(), { authorize: undefined });
    const listed = await audit.dataChanges(op.as, { objectType: IDP_OBJECTS.subProcess.code, limit: '100' });
    const shown = listed.items.find((item) => item.id === log.id)!;
    expect(shown.changes).toContainEqual(expect.objectContaining({ field: 'name', to: STAGE_NAME }));
    expect(shown.changes.some((change) => change.field === 'endNoticeTemplate')).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(TEMPLATE);
    const trimmed = await audit.dataChange(op.as, log.id);
    expect(trimmed.after).toMatchObject({ name: STAGE_NAME });
    expect(trimmed.before).not.toHaveProperty('endNoticeTemplate');
    expect(trimmed.after).not.toHaveProperty('endNoticeTemplate');
    expect(JSON.stringify(trimmed)).not.toContain(TEMPLATE);
  });
});
