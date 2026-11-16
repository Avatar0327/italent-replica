import { randomUUID } from 'node:crypto';
import { and, eq, esignTaskFiles, esignTasks, sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { linkageWorld } from './AC-LNK-support.js';
import type { TemplateView } from './AC-TRF-F481-support.js';

export const SIGN_AT = '2026-10-10T01:00:00.000Z';
export const SIGN_DAY = '2026-10-10';
export async function signWorld(db: Db, label: string) {
  const w = await linkageWorld(db, `f481-${label}`);
  const tenantId = w.session.tenant.id;
  const call = (method: string, path: string, options: { body?: unknown; ifMatch?: number } = {}) =>
    w.api.request(method, `/api/tenant/esign${path}`, { ...w.as, ...options });
  async function template(suffix: string) {
    const response = await call('POST', '/templates', {
      body: {
        code: `syn.esign.${suffix}_${randomUUID()}`,
        name: `ZZ_F481_${suffix}`,
        body: '{员工姓名}|{工号}|{调动生效日期}|{调出部门}|{调入部门}|{新合同开始日期}|{新合同结束日期}|{发起日期}|{企业名称}',
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as TemplateView;
  }
  const templates = [await template('A'), await template('B'), await template('C')];
  const person = await w.hire('ZZ_F481_EMP_01');
  const contract = await w.contract(person.employee.id);
  const linkage = (ids = templates.slice(0, 2).map((t) => t.id)) => ({
    contract: { targetId: contract.id, fields: { endDate: '2029-10-09' } },
    esign: { templateIds: ids },
  });
  const tasks = () =>
    withTenant(db, tenantId, (tx) => tx.select().from(esignTasks).where(eq(esignTasks.tenantId, tenantId)));
  const files = (taskId: string) =>
    withTenant(db, tenantId, (tx) =>
      tx
        .select()
        .from(esignTaskFiles)
        .where(and(eq(esignTaskFiles.tenantId, tenantId), eq(esignTaskFiles.taskId, taskId)))
        .orderBy(esignTaskFiles.seq),
    );
  const notices = () =>
    withTenant(db, tenantId, async (tx) => {
      const result = await tx.execute(sql`SELECT template_code,recipient_user_id,business_type,business_id,payload
      FROM approval_notifications WHERE tenant_id=${tenantId} AND business_type='esign_task'
      ORDER BY template_code`);
      return rows<Record<string, unknown>>(result);
    });
  async function direct(extra: Record<string, unknown> = {}) {
    w.session.setNow(SIGN_AT);
    return w.saved(await w.transfer(person, { mode: 'direct', submit: false, linkage: linkage(), ...extra }));
  }
  return {
    ...w,
    person,
    originalContract: contract,
    tenantId,
    call,
    template,
    templates,
    linkage,
    tasks,
    files,
    notices,
    direct,
  };
}
export type SignWorld = Awaited<ReturnType<typeof signWorld>>;
export function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
