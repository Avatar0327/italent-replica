/** BE-6a 实习生验收夹具：实习生经通用入职入口新增（employType=intern），转正、视图、重聘判定都经 HTTP 路由。 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { employmentSession, withLoginEmail, type EmploymentSession } from './AC-EMP-support.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { tenantApi } from './support/tenant-api.js';

/** 视图条目：只列用例里按名字取用的键，其余按 toMatchObject 比对。 */
export type InternViewItem = Record<string, unknown> & { readonly id: string; readonly name?: string };

export async function internWorld(db: Db, label: string) {
  const session = await employmentSession(db, label);
  // 实习转正申请提交须匹配已发布流程（DEC-017），本组只验证视图归属，安装兜底流程
  await installApprovalFallbacks(db, session.tenant.id, session.user.id);
  const org = await session.org(`实习部门-${label}`, { establishedOn: '2026-01-01' });
  const other = await session.org(`转正部门-${label}`, { establishedOn: '2026-01-01' });
  return { db, session, org, other, ...helpers(db, session, org.id) };
}
export type InternWorld = Awaited<ReturnType<typeof internWorld>>;

function helpers(db: Db, session: EmploymentSession, orgId: string) {
  const revision = async (employeeId: string) => (await session.getEmployee(employeeId)).revision;
  const portContext = (expectedRevision: number) => ({
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date('2026-10-01T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision,
  });

  async function hire(name: string, employType: 'intern' | 'internal', extra: Record<string, unknown> = {}) {
    const employee = await session.employee(name);
    const body = {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { employType, departmentId: orgId },
    };
    const response = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(employee.id, { ...body, ...extra }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return { employee, hireId: ((await response.json()) as { id: string }).id, name };
  }

  /** 直接实习转正：返回原始响应，失败用例要读状态码与错误码。 */
  const regularize = async (employeeId: string, body: Record<string, unknown>, ifMatch?: number) =>
    session.request('POST', `/interns/${employeeId}/regularize`, {
      ifMatch: ifMatch ?? (await revision(employeeId)),
      body,
    });

  /** 直接实习转正且必须成功，返回新业务 ID。 */
  async function regularizeOk(employeeId: string, effectiveDate: string, departmentId: string, extra: object = {}) {
    const response = await regularize(employeeId, { effectiveDate, departmentId, probation: false, ...extra });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** 审批中心最后节点通过时调用的可信端口（transitions.approve）。 */
  async function approve(businessId: string) {
    const { revision: current } = (await (await session.request('GET', `/businesses/${businessId}`)).json()) as {
      revision: number;
    };
    await runEmploymentTransition(db, portContext(current), { id: businessId, action: 'approve' });
  }

  /** 发起并提交实习转正申请（审批中）。 */
  async function applyRegularization(employeeId: string, effectiveDate = '2026-10-20') {
    const input = { kind: 'intern_regularization', mode: 'application', effectiveDate, fields: {} };
    const draft = await session.business(employeeId, input, await revision(employeeId));
    const submitted = await session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    return draft.id;
  }

  /** 离职造数：测试 API 的可信离职端口（不经离职门禁，不是 BE-6b 的结束实习）。 */
  const leave = async (employeeId: string, lastWorkDate = '2026-09-20') =>
    session.business(
      employeeId,
      { kind: 'leave', mode: 'direct', lastWorkDate, fields: {} },
      await revision(employeeId),
    );

  /** 退休造数：R2-T04 的可信端口（trustedExit = retirement）。 */
  async function retire(employeeId: string, lastWorkDate: string) {
    const ctx = { ...portContext(await revision(employeeId)), trustedExit: 'retirement' as const };
    const input = { kind: 'retirement' as const, mode: 'direct' as const, lastWorkDate, fields: {} };
    return withTenant(db, session.tenant.id, (tx) => createEmploymentBusiness(tx, ctx, employeeId, input));
  }

  async function view(name: string, query = ''): Promise<InternViewItem[]> {
    const response = await session.request('GET', `/interns?view=${name}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: InternViewItem[] }).items;
  }

  /** 人员信息里的证件与个人邮箱（personnel 版本链，HR 直接修改）。 */
  async function identify(employeeId: string, idType: string, idNumber: string, email?: string) {
    const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const as = { user: session.user.id, tenant: session.tenant.id };
    const path = `/api/tenant/personnel/employees/${employeeId}`;
    const { revision: ifMatch } = (await (await api.request('GET', path, as)).json()) as { revision: number };
    const response = await api.request('PATCH', path, { ...as, ifMatch, body: { idType, idNumber, email } });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  const match = (body: Record<string, unknown>) => session.request('POST', '/rehire-matches', { body });

  return {
    hire,
    revision,
    regularize,
    regularizeOk,
    approve,
    applyRegularization,
    leave,
    retire,
    view,
    identify,
    match,
  };
}

export const names = (items: readonly { name?: string }[]) => items.map((item) => item.name).sort();
