/**
 * BE-R2d4c 新增实习生一体写入夹具：经 HTTP 路由 POST /interns 一个请求完成建档 / 重聘 + 任职 + 合同。
 * 合同主数据（合同类型、法人公司）走合同模块的主数据接口；待入职合同直接读表（接口里没有该列）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { withTenant } from '@italent/db';
import { expect } from 'vitest';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';
import { loadPendingContract } from '../../apps/api/src/modules/employment/entry-pending-contract.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const NOW = new Date('2026-10-01T01:00:00.000Z');

export async function createWorld(db: Parameters<typeof internWorld>[0], label: string) {
  const w = await internWorld(db, label);
  const api = tenantApi(db, { clock: () => NOW });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await api.request('POST', `/api/tenant/contracts/master-data/${kind}`, {
      ...as,
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const typeId = await master('types', '实习协议');
  const companyId = await master('companies', '合成法人公司');
  return { w, typeId, companyId, ...helpers(w, db, api, as) };
}
export type CreateWorld = Awaited<ReturnType<typeof createWorld>>;

type Api = ReturnType<typeof tenantApi>;

function helpers(w: InternWorld, db: InternWorld['db'], api: Api, as: { user: string; tenant: string }) {
  const tenantId = w.session.tenant.id;

  /** 新增实习生请求体：缺省入职日为今天（2026-10-01）、挂实习部门。 */
  function hireBody(extra: Record<string, unknown> = {}) {
    const suffix = uniqueSuffix();
    return {
      kind: 'hire',
      code: `INT_${suffix}`,
      name: '合成实习生',
      loginEmail: `intern.${suffix}@example.com`,
      effectiveDate: '2026-10-01',
      fields: { departmentId: w.org.id },
      ...extra,
    };
  }

  /** 发 POST /interns；新增 If-Match 为 0（新对象），重聘传员工当前 revision。 */
  const create = (body: Record<string, unknown>, options: { ifMatch?: number; key?: string } = {}) =>
    w.session.request('POST', '/interns', {
      ifMatch: options.ifMatch ?? 0,
      body,
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });

  /** 同 create，但要求 201 并返回回执。 */
  async function createOk(body: Record<string, unknown>, options: { ifMatch?: number; key?: string } = {}) {
    const response = await create(body, options);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as CreateReceipt;
  }

  async function contracts(): Promise<ContractRow[]> {
    const response = await api.request('GET', '/api/tenant/contracts?view=all', as);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: ContractRow[] }).items;
  }

  /** 按工号查人员（建档失败的回滚断言用）。 */
  async function employeesByCode(code: string): Promise<{ id: string }[]> {
    const response = await w.session.request('GET', `/employees?code=${code}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: { id: string }[] }).items;
  }

  const pendingContract = (businessId: string) =>
    withTenant(db, tenantId, (tx) =>
      loadPendingContract(tx, { tenantId } as Parameters<typeof loadPendingContract>[1], businessId),
    );

  /** 按指定授权器发 POST /interns（拒权用例）。 */
  function createAs(authorize: Authorizer, body: Record<string, unknown>) {
    const denied = tenantApi(db, { authorize, clock: () => NOW });
    return denied.request('POST', '/api/tenant/employment/interns', { ...as, ifMatch: 0, body });
  }

  /** 实习四视图里的人员 ID。 */
  async function viewIds(view: string): Promise<string[]> {
    return (await w.view(view)).map((item) => item.employeeId as string);
  }

  /** 已离职实习生（证件号 + 离职日），重聘候选。 */
  async function leftIntern(name: string) {
    const person = await w.hire(name, 'intern');
    await w.identify(person.employee.id, 'id_card', `SYN${uniqueSuffix()}`);
    await w.leave(person.employee.id, '2026-09-20');
    return person;
  }

  /** 本人命令结果摘要（F-120 只读恢复链：GET /commands/:id/result），不是同键 POST 重放。 */
  async function commandResult(commandId: string) {
    const response = await api.request('GET', `/api/tenant/commands/${commandId}/result`, as);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** 把合同类型列入“无固定期限”类型（合同设置 indefiniteTypeIds）：合同服务会把终止日置空。 */
  async function markIndefinite(typeId: string) {
    const current = await api.request('GET', '/api/tenant/contracts/settings', as);
    const { revision } = (await current.json()) as { revision: number };
    const saved = await api.request('PUT', '/api/tenant/contracts/settings', {
      ...as,
      ifMatch: revision,
      body: { indefiniteTypeIds: [typeId] },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
  }

  /** 已退休实习生（证件号 + 退休日），重聘候选的 endKind = retirement。 */
  async function retiredIntern(name: string) {
    const person = await w.hire(name, 'intern');
    await w.identify(person.employee.id, 'id_card', `SYN${uniqueSuffix()}`);
    await w.retire(person.employee.id, '2026-09-20');
    return person;
  }

  /** 重聘请求体（沿用候选人员，不带工号 / 姓名）。 */
  const rehireBody = (employeeId: string, extra: Record<string, unknown> = {}) => ({
    kind: 'rehire',
    employeeId,
    effectiveDate: '2026-10-01',
    fields: { departmentId: w.org.id },
    ...extra,
  });

  return {
    commandResult,
    markIndefinite,
    retiredIntern,
    rehireBody,
    hireBody,
    create,
    createOk,
    contracts,
    employeesByCode,
    pendingContract,
    createAs,
    viewIds,
    leftIntern,
  };
}

export interface ContractRow {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly endDate: string | null;
  readonly status: string;
}

export interface CreateReceipt {
  readonly employeeId: string;
  readonly businessId: string;
  readonly id: string;
  readonly revision: number;
  readonly kind: 'hire' | 'rehire' | 'retire_rehire';
  readonly view: 'interning' | 'pendingEntry';
  readonly contract: {
    readonly stage: 'formal' | 'pending';
    readonly id: string | null;
    readonly startDate: string;
    readonly endDate: string;
    readonly companyId: string | null;
  };
}
