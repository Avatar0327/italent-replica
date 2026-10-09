/**
 * R3-T02 C1-3 当前资格与指标端口的验收夹具：一个租户（allowAll 授权，策略自己验引用）+ 任职资格配置（类别 / 级别 /
 * 指标类型 / 指标 / 标准）+ 员工与任职资格子集记录。配置经 PR-A 的真实接口创建，子集记录经人员子集通用路由。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import type { useTestDb } from '@italent/testkit';
import { qualificationWorld } from './AC-QL-support.js';

export const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

export async function currentWorld(database: ReturnType<typeof useTestDb>, label: string) {
  const db = database().db;
  const w = await qualificationWorld(db, label);
  const klass = await w.categoryClass();
  const category = await w.category(klass.id);
  const otherCategory = await w.category(klass.id);
  const p1 = await w.level(10);
  const p2 = await w.level(20);
  const p3 = await w.level(30);
  const tx = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(db, w.tenant.id, work);

  const employee = async (name = `员工${randomUUID().slice(0, 4)}`) => {
    const response = await w.api.request('POST', '/api/tenant/employment/employees', {
      ...w.as,
      ifMatch: 0,
      body: { name, code: `E${randomUUID().replaceAll('-', '').slice(0, 12)}` },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const subsetPath = (employeeId: string) => `/api/tenant/personnel/employees/${employeeId}/subsets/qualification`;
  /** HR 手工录入一条任职资格（经子集通用路由与 qualification 策略）。 */
  const record = async (employeeId: string, body: Record<string, unknown> = {}) => {
    const response = await w.api.request('POST', subsetPath(employeeId), {
      ...w.as,
      ifMatch: 0,
      body: { categoryId: category.id, levelId: p1.id, startDate: '2026-01-01', ...body },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  };
  const remove = async (employeeId: string, saved: { id: string; revision: number }) => {
    const response = await w.api.request('DELETE', `${subsetPath(employeeId)}/${saved.id}`, {
      ...w.as,
      ifMatch: saved.revision,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  /** 可信夹具：像任职同步（C1-4）/ 评定发布（C2-8）那样直接写一条系统来源的行。 */
  const systemRecord = async (
    employeeId: string,
    type: 'employment_sync' | 'evaluation' | 'initialization',
    body: Record<string, unknown> = {},
  ) => {
    const { saveSubset } = await import('../../apps/api/src/modules/personnel/subsets.js');
    return tx((t) =>
      saveSubset(
        t,
        {
          tenantId: w.tenant.id,
          userId: w.user.id,
          timezone: 'Asia/Shanghai',
          now: new Date('2026-10-09T02:00:00.000Z'),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        employeeId,
        'qualification',
        { categoryId: category.id, levelId: p1.id, startDate: '2026-01-01', ...body },
        undefined,
        false,
        { type, id: randomUUID() },
      ),
    );
  };
  const count = (query: ReturnType<typeof sql>) =>
    tx(async (t) => Number(rowsOf<{ n: number }>(await t.execute(query))[0]!.n));
  return { w, db, tx, klass, category, otherCategory, p1, p2, p3, employee, record, remove, systemRecord, count };
}

export type CurrentWorld = Awaited<ReturnType<typeof currentWorld>>;
