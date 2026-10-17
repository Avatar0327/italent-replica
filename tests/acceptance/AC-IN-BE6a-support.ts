/**
 * BE-6a 实习生验收夹具（docs/02_业务建模/31 §2；差距表 B34～B41、A48；补证结论 R2f B41）：
 * 实习生经通用入职入口新增（employType=intern），直接实习转正、实习四视图、重聘判定都经 HTTP 路由。
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { employmentSession, withLoginEmail, type EmploymentSession } from './AC-EMP-support.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { tenantApi } from './support/tenant-api.js';

export interface InternViewItem {
  readonly id: string;
  readonly employeeId: string;
  readonly code?: string;
  readonly name?: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly entryDate: string;
  readonly departmentId?: string | null;
  readonly positionId?: string | null;
  readonly employType?: string | null;
  readonly employeeStatus: number;
  readonly revision: number;
  readonly state: string;
  readonly lastWorkDate: string | null;
  readonly probation: { startDate: string; months: number; endDate: string } | null;
}

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
  async function hire(name: string, employType: 'intern' | 'internal', extra: Record<string, unknown> = {}) {
    const employee = await session.employee(name);
    const response = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(employee.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType, departmentId: orgId },
        ...extra,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string };
    return { employee, hireId: business.id, name };
  }

  const revision = async (employeeId: string) => (await session.getEmployee(employeeId)).revision;

  /** 直接实习转正：返回原始响应，失败用例要读状态码与错误码。 */
  async function regularize(employeeId: string, body: Record<string, unknown>, ifMatch?: number) {
    return session.request('POST', `/interns/${employeeId}/regularize`, {
      ifMatch: ifMatch ?? (await revision(employeeId)),
      body,
    });
  }

  /** 发起并提交实习转正申请（审批中）。 */
  async function applyRegularization(employeeId: string, effectiveDate = '2026-10-20') {
    const draft = await session.business(
      employeeId,
      { kind: 'intern_regularization', mode: 'application', effectiveDate, fields: {} },
      await revision(employeeId),
    );
    const submitted = await session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    return draft.id;
  }

  /** 离职造数：经测试 API 的可信离职端口（不经离职门禁，不落 BE-6b 的结束实习）。 */
  async function leave(employeeId: string, lastWorkDate = '2026-09-20') {
    return session.business(
      employeeId,
      { kind: 'leave', mode: 'direct', lastWorkDate, fields: {} },
      await revision(employeeId),
    );
  }

  /** 退休造数：R2-T04 的可信端口（trustedExit = retirement）。 */
  async function retire(employeeId: string, lastWorkDate = '2026-09-20') {
    const expectedRevision = await revision(employeeId);
    return withTenant(db, session.tenant.id, (tx) =>
      createEmploymentBusiness(
        tx,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          timezone: session.tenant.timezone,
          now: new Date('2026-10-01T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision,
          trustedExit: 'retirement',
        },
        employeeId,
        { kind: 'retirement', mode: 'direct', lastWorkDate, fields: {} },
      ),
    );
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
    const current = await api.request('GET', `/api/tenant/personnel/employees/${employeeId}`, as);
    expect(current.status, await current.clone().text()).toBe(200);
    const { revision: personRevision } = (await current.json()) as { revision: number };
    const response = await api.request('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
      ...as,
      ifMatch: personRevision,
      body: { idType, idNumber, ...(email ? { email } : {}) },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function match(body: Record<string, unknown>) {
    return session.request('POST', '/rehire-matches', { body });
  }

  return { hire, revision, regularize, applyRegularization, leave, retire, view, identify, match };
}

export const names = (items: readonly { name?: string }[]) => items.map((item) => item.name).sort();
