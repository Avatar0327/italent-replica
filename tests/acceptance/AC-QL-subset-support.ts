/**
 * R3-T02 C1-1 任职资格子集的验收夹具：审批世界（HR、员工、审批流程）+ 一套任职资格配置（类别 / 级别，含停用的）。
 * 类别 / 级别经 PR-A 的真实接口创建；HR 兼任管理单元管理员，只为建配置对象，子集本身的权限走 allowAll（由策略自己验权）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { assignQualificationMou, type CategoryView, QL_BASE, type LevelView } from './AC-QL-support.js';
import { createMou, createOrg } from './AC-TC-support.js';
import type { useTestDb } from '@italent/testkit';

export const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
export const REQUESTS = '/api/tenant/personnel/change-requests';
export const SETTING_SYNC = 'qualification.sync_enabled';
export const SETTING_EDITABLE = 'qualification.auto_sync_editable';

export type World = Awaited<ReturnType<typeof subsetScene>>;

export async function subsetScene(database: ReturnType<typeof useTestDb>, label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const who = w.as(w.hr.id);
  const orgId = await createOrg(w.api, who, `${label}任职资格部`);
  const mouId = await createMou(w.api, who, [orgId], '任职资格');
  await assignQualificationMou(w.api, who, w.hr.id, mouId, 0);
  const create = async <T>(path: string, body: unknown): Promise<T> =>
    w.json<T>(await w.request(w.hr.id, 'POST', `${QL_BASE}${path}`, { ifMatch: 0, body }), 201);
  const suffix = () => randomUUID().slice(0, 6);
  const klass = await create<{ id: string }>('/category-classes', { code: `K${suffix()}`, name: '管理类' });
  const category = (extra: Record<string, unknown> = {}) =>
    create<CategoryView>('/categories', { code: `C${suffix()}`, name: `类别${suffix()}`, classId: klass.id, ...extra });
  const level = (displayOrder: number, extra: Record<string, unknown> = {}) =>
    create<LevelView>('/levels', { code: `L${suffix()}`, name: `P${displayOrder}`, displayOrder, ...extra });
  const catalog = {
    category: await category(),
    otherCategory: await category(),
    disabledCategory: await category({ enabled: false }),
    level: await level(1),
    otherLevel: await level(2),
    disabledLevel: await level(3, { enabled: false }),
  };
  const path = `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/qualification`;
  const base = (extra: Record<string, unknown> = {}) => ({
    categoryId: catalog.category.id,
    levelId: catalog.level.id,
    startDate: '2026-01-01',
    ...extra,
  });
  const add = (extra: Record<string, unknown> = {}) =>
    w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: base(extra) });
  const addOk = async (extra: Record<string, unknown> = {}) =>
    w.json<{ id: string; revision: number; [key: string]: unknown }>(await add(extra), 201);
  const tx = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant(w.db, w.tenant.id, work);
  /** 可信夹具：像任职同步（C1-4）那样直接写一条自动同步的行。 */
  const autoRow = async () => {
    const { saveSubset } = await import('../../apps/api/src/modules/personnel/subsets.js');
    return tx((t) =>
      saveSubset(
        t,
        {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          timezone: 'Asia/Shanghai',
          now: w.clock(),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        s.subject.employeeId,
        'qualification',
        base({ isAutoSync: true, employmentRecordId: randomUUID() }),
        undefined,
        false,
        { type: 'employment_sync', id: randomUUID() },
      ),
    );
  };
  const rows = () =>
    tx(async (t) =>
      rowsOf<Record<string, unknown>>(
        await t.execute(sql`SELECT * FROM personnel_qualification
          WHERE employee_id = ${s.subject.employeeId}::uuid ORDER BY created_at, id`),
      ),
    );
  const count = (query: ReturnType<typeof sql>) =>
    tx(async (t) => Number(rowsOf<{ n: number }>(await t.execute(query))[0]!.n));
  const setSetting = async (key: string, value: unknown, revision: number) =>
    w.json<{ value: unknown; revision: number }>(
      await w.request(w.hr.id, 'PUT', `/api/tenant/settings/${key}`, { ifMatch: revision, body: { value } }),
    );
  expect(catalog.category.id).toBeTruthy();
  return { w, s, catalog, path, base, add, addOk, tx, autoRow, rows, count, setSetting };
}
