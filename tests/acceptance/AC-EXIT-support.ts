/**
 * R2-T03 离职验收测试的共用夹具（设计 §4A：业务造数放这里，packages/testkit 不放业务造数）。
 * exitWorld：任职会话 + 按 DEC-361 登记表补装离职字典预置项（seedTenantWithMember 不走开通流程，需显式补装）。
 * seedExitBusiness：可信造数——经现有任职入口办入职与直接离职，再在同一租户内补写离职扩展行；
 * B2a 接入离职门禁后改走服务端可信端口 ctx.trustedExit = 'seed'（§4A），调用方签名不变。
 */
import { randomUUID } from 'node:crypto';
import { exitRequests, sql, withTenant, type Db } from '@italent/db';
import type { ExitDictionaryKind } from '@italent/domain';
import { expect } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession } from './AC-EMP-support.js';
import { rowsOf } from './AC-EMP-F055-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export interface ExitDictionaryEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly revision: number;
}

export async function installExitSeeds(db: Db, tenantId: string, actorUserId: string | null = null) {
  return withTenant(db, tenantId, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId, actorUserId, now: new Date(), commandId: `exit-seed-${randomUUID()}` },
      { modules: ['employment'] },
    ),
  );
}

export async function exitWorld(db: Db, label: string) {
  const session = await employmentSession(db, `exit-${label}`);
  await installExitSeeds(db, session.tenant.id, session.user.id);
  const dictionaryPath = (kind: ExitDictionaryKind | string, id?: string) =>
    `/exits/dictionaries/${kind}${id ? `/${id}` : ''}`;

  async function list(kind: ExitDictionaryKind, query = '', options: RequestOptions = {}) {
    const response = await session.request('GET', `${dictionaryPath(kind)}${query}`, options);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: ExitDictionaryEntry[] }).items;
  }
  const add = (kind: ExitDictionaryKind | string, body: unknown, options: RequestOptions = {}) =>
    session.request('POST', dictionaryPath(kind), { ifMatch: 0, body, ...options });
  const update = (kind: ExitDictionaryKind | string, id: string, revision: number, body: unknown) =>
    session.request('PUT', dictionaryPath(kind, id), { ifMatch: revision, body });
  async function added(kind: ExitDictionaryKind, body: Record<string, unknown>) {
    const response = await add(kind, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ExitDictionaryEntry;
  }

  async function hired(name = '离职员工') {
    const org = await session.org(`${name}部门`, { establishedOn: '2025-01-01' });
    const employee = await session.employee(name);
    await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
      employee.revision,
    );
    return { employee: await session.getEmployee(employee.id), org };
  }

  /** 可信造数：直接离职一条（main 现有任职入口），并补写离职扩展行；values 覆盖扩展行列。 */
  async function seedExitBusiness(values: Partial<typeof exitRequests.$inferInsert> = {}, lastWorkDate = '2026-09-20') {
    const { employee } = await hired();
    const business = await session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate },
      employee.revision,
    );
    await withTenant(db, session.tenant.id, async (tx) => {
      const [cycle] = rowsOf<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM employment_cycles WHERE tenant_id=${session.tenant.id} AND employee_id=${employee.id}::uuid
          ORDER BY entry_date DESC LIMIT 1`),
      );
      await tx.insert(exitRequests).values({
        tenantId: session.tenant.id,
        businessId: business.id,
        employeeId: employee.id,
        staffId: cycle!.id,
        mode: 'direct',
        initiator: 'hr',
        initiatorUserId: session.user.id,
        dutyTransferTiming: 'business_effective',
        ...values,
      });
    });
    return { employee, business };
  }

  return { ...session, db, list, add, update, added, hired, seedExitBusiness };
}

export type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;
