/**
 * R3-T02 C1-4 任职资格同步的验收夹具（设计 §4.2 / §4.3；拆分方案 §5 C1-4）。
 * 在 F-055 的任职夹具（一个租户、一名已入职员工、真实的任职保存 / 删除入口）上加：
 * - 任职资格映射配置（类别 / 级别及其与岗职务的关联）：直接写 ql_* 表，与配置接口无关；
 * - SW73 开关、真实调度器的一轮（runQualificationSync）、队列与子集的读取。
 * 测试用合成数据。
 */
import { randomUUID } from 'node:crypto';
import {
  qlCategories,
  qlCategoryClasses,
  qlCategoryJobLinks,
  qlLevelJobLinks,
  qlLevels,
  sql,
  withTenant,
} from '@italent/db';
import type { QualificationCategoryLink, QualificationLevelLink } from '@italent/db';
import { expect } from 'vitest';
import type { Db } from '@italent/db';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { runQualificationSync } from '../../apps/api/src/modules/qualification/sync-worker.js';
import { f055World, rowsOf, type F055World } from './AC-EMP-F055-support.js';
import { tenantApi } from './support/tenant-api.js';

export { rowsOf };
export const SYNC_SETTING = 'qualification.sync_enabled';
export const HANDLER = 'qualification_sync';

export interface QueueRow {
  readonly state: string;
  readonly reason: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly recordId: string;
  readonly employeeId: string;
  readonly dedupeKey: string;
}

export type SyncWorld = Awaited<ReturnType<typeof syncWorld>>;

export async function syncWorld(db: Db, label: string, options: { timezone?: string } = {}) {
  const w = await f055World(db, label, options);
  const tenantId = w.tenantId;
  const userId = w.session.user.id;
  const api = tenantApi(db);
  const as = { user: userId, tenant: tenantId };
  const settingRevisions = new Map<string, number>();

  /** 租户覆盖某个设置（按键各自记 revision）。 */
  async function setSetting(key: string, value: boolean) {
    const revision = settingRevisions.get(key) ?? 0;
    await withTenant(db, tenantId, (tx) =>
      overrideSetting(
        tx,
        { tenantId, userId, key, expectedRevision: revision, now: new Date(), commandId: randomUUID() },
        value,
      ),
    );
    settingRevisions.set(key, revision + 1);
  }

  /** 租户覆盖 SW73（qualification.sync_enabled）。 */
  const enableSync = (value: boolean) => setSetting(SYNC_SETTING, value);

  /** 组织员工侧的职务序列（任职记录的 sequenceId 要能通过存在性校验）。 */
  async function sequence(name: string): Promise<string> {
    const response = await api.request('POST', '/api/tenant/job/sequences', {
      ...as,
      ifMatch: 0,
      body: { name, code: `S${randomUUID().slice(0, 6)}`, startDate: '2020-01-01' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** 组织员工侧的职级（先建职级类别）；任职记录的 levelId 要能通过存在性校验。 */
  async function jobLevel(): Promise<string> {
    const type = await api.request('POST', '/api/tenant/job/level-types', {
      ...as,
      ifMatch: 0,
      body: { name: '同步职级体系', code: `LT${randomUUID().slice(0, 6)}`, startDate: '2020-01-01' },
    });
    expect(type.status, await type.clone().text()).toBe(201);
    const created = await api.request('POST', '/api/tenant/job/levels', {
      ...as,
      ifMatch: 0,
      body: {
        name: '同步职级',
        code: `JL${randomUUID().slice(0, 6)}`,
        level: 5,
        levelTypeId: ((await type.json()) as { id: string }).id,
        startDate: '2020-01-01',
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  /** 组织员工侧的职等（先建职层）；任职记录的 gradeId 要能通过存在性校验。 */
  async function jobGrade(): Promise<string> {
    const layer = await api.request('POST', '/api/tenant/job/layers', {
      ...as,
      ifMatch: 0,
      body: { name: '同步职层', code: `LY${randomUUID().slice(0, 6)}`, layerLevel: 1, startDate: '2020-01-01' },
    });
    expect(layer.status, await layer.clone().text()).toBe(201);
    const created = await api.request('POST', '/api/tenant/job/grades', {
      ...as,
      ifMatch: 0,
      body: {
        name: '同步职等',
        code: `JG${randomUUID().slice(0, 6)}`,
        grade: 1,
        layerId: ((await layer.json()) as { id: string }).id,
        startDate: '2020-01-01',
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  /** 保存一条调动（HR 直写），可带岗职务字段；返回业务单（= 任职记录）标识。 */
  async function transferWith(
    effectiveDate: string,
    fields: Record<string, unknown>,
    employeeId = w.subject.employee.id,
  ): Promise<string> {
    const employee = await w.session.getEmployee(employeeId);
    const business = await w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: w.to.id, ...fields } },
      employee.revision,
    );
    expect(business.status).toBe('effective');
    return business.id;
  }

  /** 直接写任职资格配置：一个分类 + 类别 / 级别，各自关联给定的岗职务对象（job_object_id 不设外键）。 */
  async function category(
    link: { type: QualificationCategoryLink; jobObjectId: string } | null,
    extra: { enabled?: boolean } = {},
  ): Promise<string> {
    return withTenant(db, tenantId, async (tx) => {
      const classId = await classRow(tx);
      const code = `C${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const [row] = await tx
        .insert(qlCategories)
        .values({
          tenantId,
          code,
          name: `类别${code}`,
          classId,
          jobLinkType: link?.type ?? null,
          enabled: extra.enabled ?? true,
          ownerId: userId,
          ownerOrgId: w.from.id,
          createdBy: userId,
        })
        .returning({ id: qlCategories.id });
      if (link)
        await tx
          .insert(qlCategoryJobLinks)
          .values({ tenantId, categoryId: row!.id, jobLinkType: link.type, jobObjectId: link.jobObjectId });
      return row!.id;
    });
  }
  let order = 0;
  async function level(
    link: { type: QualificationLevelLink; jobObjectId: string } | null,
    extra: { enabled?: boolean } = {},
  ): Promise<string> {
    order += 10;
    return withTenant(db, tenantId, async (tx) => {
      const code = `L${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const [row] = await tx
        .insert(qlLevels)
        .values({
          tenantId,
          code,
          name: `级别${code}`,
          displayOrder: order,
          jobLinkType: link?.type ?? null,
          enabled: extra.enabled ?? true,
          ownerId: userId,
          ownerOrgId: w.from.id,
          createdBy: userId,
        })
        .returning({ id: qlLevels.id });
      if (link)
        await tx
          .insert(qlLevelJobLinks)
          .values({ tenantId, levelId: row!.id, jobLinkType: link.type, jobObjectId: link.jobObjectId });
      return row!.id;
    });
  }
  let classId: string | undefined;
  async function classRow(tx: Parameters<Parameters<typeof withTenant>[2]>[0]): Promise<string> {
    if (classId) return classId;
    const [row] = await tx
      .insert(qlCategoryClasses)
      .values({
        tenantId,
        code: `K${randomUUID().replaceAll('-', '').slice(0, 10)}`,
        name: '同步测试分类',
        level: 1,
        ownerId: userId,
        ownerOrgId: w.from.id,
        createdBy: userId,
      })
      .returning({ id: qlCategoryClasses.id });
    classId = row!.id;
    return classId;
  }

  /** 真实调度器的一轮（平台遍历之外的单租户入口）；时钟固定在 at。 */
  const run = (at: string, options: { limit?: number } = {}) =>
    runQualificationSync(db, tenantId, { clock: () => new Date(at), ...options });

  const queue = (recordId?: string): Promise<QueueRow[]> =>
    withTenant(db, tenantId, async (tx) =>
      rowsOf<QueueRow>(
        await tx.execute(sql`SELECT state, reason, attempts, next_attempt_at::text AS "nextAttemptAt",
          record_id AS "recordId", employee_id AS "employeeId", dedupe_key AS "dedupeKey"
          FROM ev_sync_queue WHERE tenant_id=${tenantId} AND handler=${HANDLER}
            AND (${recordId ?? null}::uuid IS NULL OR record_id=${recordId ?? null}::uuid)
          ORDER BY created_at, id`),
      ),
    );

  const subsets = (employeeId = w.subject.employee.id) =>
    withTenant(db, tenantId, async (tx) =>
      rowsOf<{
        id: string;
        categoryId: string;
        levelId: string;
        startDate: string;
        endDate: string | null;
        sourceType: string;
        sourceId: string;
        isAutoSync: boolean;
        employmentRecordId: string | null;
      }>(
        await tx.execute(sql`SELECT id, category_id AS "categoryId", level_id AS "levelId",
          start_date::text AS "startDate", end_date::text AS "endDate", source_type AS "sourceType",
          source_id AS "sourceId", is_auto_sync AS "isAutoSync", employment_record_id AS "employmentRecordId"
          FROM personnel_qualification WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
            AND NOT deleted ORDER BY start_date, created_at`),
      ),
    );

  /** 子集的全部版本（含删除）：看“谁在什么时候收尾 / 删除”，来源以每个版本落笔时为准。 */
  const history = (employeeId = w.subject.employee.id) =>
    withTenant(db, tenantId, async (tx) =>
      rowsOf<{
        recordId: string;
        revision: number;
        deleted: boolean;
        sourceType: string;
        categoryId: string;
        startDate: string;
        endDate: string | null;
        employmentRecordId: string | null;
      }>(
        await tx.execute(sql`SELECT record_id AS "recordId", revision, deleted, source_type AS "sourceType",
          category_id AS "categoryId", start_date::text AS "startDate", end_date::text AS "endDate",
          employment_record_id AS "employmentRecordId"
          FROM personnel_qualification_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
          ORDER BY created_at, revision`),
      ),
    );

  /** 同一任职事件再入队一行（模拟重复事件 / 重试路径），用来验证已同步的足迹。 */
  const requeue = (recordId: string) =>
    withTenant(db, tenantId, (tx) =>
      tx.execute(sql`INSERT INTO ev_sync_queue
          (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
        SELECT tenant_id, handler, 'dup-' || gen_random_uuid()::text, outbox_id, employee_id, record_id, next_attempt_at
        FROM ev_sync_queue WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid LIMIT 1`),
    );

  /** 夹具自带的入职事件视为已处理，让用例只关心自己保存的记录。 */
  async function settleBaseline(at = '2026-10-01T05:00:00Z') {
    await run(at);
  }

  return {
    ...w,
    api,
    as,
    enableSync,
    setSetting,
    sequence,
    jobLevel,
    jobGrade,
    transferWith,
    category,
    level,
    run,
    queue,
    subsets,
    history,
    requeue,
    settleBaseline,
  };
}

export type { F055World };
