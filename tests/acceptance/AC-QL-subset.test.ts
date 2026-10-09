/**
 * R3-T02 C1-1 任职资格子集（拆分方案第 5 节 C1-1；设计 §3.3、§4.1；规格 23 §10；DEC-331③、DEC-352、DEC-365③）：
 * - 字段全集读写：沿用人员子集框架，对象 TenantBase.Qualification，来源增 initialization / evaluation / employment_sync；
 * - 经 P0 钩子登记 qualification 策略：类别 / 级别须对操作人可见且启用（DEC-352，只拦新引用）；SW74 关闭时自动同步的行
 *   改删 409 QUALIFICATION_SUBSET_LOCKED（按当前开关实时判断，手工行不受影响）；自助不开放 🟡（首次提交 / 同单重提 /
 *   落地前复核一律 403，不留申请、审批实例、申请审计）；
 * - SW73 / SW74 两个系统预置开关（全局行，两层配置）与 SW73 设置页提示。
 * 测试用合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { PERSONNEL_REQUEST_OBJECT, QUALIFICATION_SETTINGS, SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { saveInformationCollection } from '../../apps/api/src/modules/personnel/integrations.js';
import { saveSubset } from '../../apps/api/src/modules/personnel/subsets.js';
import type { InstanceView } from './AC-APV-support.js';
import { QL_BASE } from './AC-QL-support.js';
import { REQUESTS, rowsOf, SETTING_EDITABLE, SETTING_SYNC, subsetScene } from './AC-QL-subset-support.js';

const database = useTestDb();
const APPROVAL = '/api/tenant/approval';

const reasonOf = async (response: Response) =>
  ((await response.clone().json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason;
const codeOf = async (response: Response) =>
  ((await response.clone().json()) as { error: { code: string } }).error.code;

describe('AC-QL-subset 子集定义与字段全集读写（DEC-331③，规格 23 §10）', () => {
  it('SUBSETS.qualification：对象 TenantBase.Qualification，字段全集（业务字段 + 系统字段）', () => {
    expect(SUBSETS.qualification.objectCode).toBe('TenantBase.Qualification');
    expect(SUBSETS.qualification.table).toBe('personnel_qualification');
    const fields = new Map<string, { kind: string; system?: boolean }>(
      SUBSETS.qualification.fields.map((field) => [field.code, field]),
    );
    const business = ['categoryId', 'levelId', 'startDate', 'endDate', 'finalScore'];
    const system = ['isAutoSync', 'employmentRecordId', 'activityTypeId', 'evaluationId', 'result'];
    for (const code of business) expect(fields.get(code), code).toBeTruthy();
    for (const code of business) expect((fields.get(code) as { system?: boolean }).system, code).not.toBe(true);
    for (const code of system) expect((fields.get(code) as { system?: boolean } | undefined)?.system, code).toBe(true);
  });

  it('HR 新增 / 修改 / 删除：字段齐全、来源 hr_direct、isAutoSync 为 false、版本与审计同事务', async () => {
    const { w, s, path, add, addOk, rows, count } = await subsetScene(database, 'qs-crud');
    const created = await addOk({ endDate: '2026-12-31', finalScore: 88.5 });
    expect(created).toMatchObject({
      employeeId: s.subject.employeeId,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      isAutoSync: false,
      sourceType: 'hr_direct',
      revision: 1,
    });
    expect(Number((await rows())[0]!.final_score)).toBe(88.5);
    const listed = await w.json<{ items: { id: string }[] }>(await w.request(w.hr.id, 'GET', path));
    expect(listed.items.map((item) => item.id)).toEqual([created.id]);

    const patched = await w.json<{ revision: number; endDate: string }>(
      await w.request(w.hr.id, 'PATCH', `${path}/${created.id}`, { ifMatch: 1, body: { endDate: '2027-06-30' } }),
    );
    expect(patched).toMatchObject({ revision: 2, endDate: '2027-06-30' });
    const removed = await w.request(w.hr.id, 'DELETE', `${path}/${created.id}`, { ifMatch: 2 });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await rows()).toMatchObject([{ deleted: true, revision: 3 }]);
    expect(await count(sql`SELECT count(*)::int AS n FROM personnel_qualification_versions`)).toBe(3);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = 'TenantBase.Qualification'`),
    ).toBe(3);
    expect((await add()).status).toBe(201);
  });

  it('必填与格式：缺类别 / 级别 / 开始日期、结束早于开始、系统字段经 HTTP 提交均 400，不留行', async () => {
    const { w, path, add, rows, catalog } = await subsetScene(database, 'qs-validate');
    const bad = [
      { categoryId: null },
      { levelId: null },
      { startDate: null },
      { startDate: '2026-05-01', endDate: '2026-04-01' },
      { categoryId: 'not-a-uuid' },
      { isAutoSync: true },
      { evaluationId: randomUUID() },
    ];
    for (const extra of bad) {
      const response = await add(extra);
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(await codeOf(response)).toBe('VALIDATION_FAILED');
    }
    const missing = await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { levelId: catalog.level.id } });
    expect(missing.status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('来源类型：employment_sync / initialization / evaluation 可写入，来源单据必填；未知来源被数据库拒绝', async () => {
    const { w, s, tx, base, rows } = await subsetScene(database, 'qs-source');
    const save = (type: 'employment_sync' | 'initialization' | 'evaluation', id: string | null, extra = {}) =>
      tx((t) =>
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
          base(extra),
          undefined,
          false,
          { type, id },
        ),
      );
    await save('employment_sync', randomUUID(), { isAutoSync: true });
    await save('initialization', randomUUID());
    await save('evaluation', randomUUID(), { evaluationId: randomUUID() });
    expect((await rows()).map((row) => row.source_type).sort()).toEqual([
      'employment_sync',
      'evaluation',
      'initialization',
    ]);
    await expect(save('initialization', null)).rejects.toThrow();
    await expect(
      tx((t) =>
        t.execute(sql`INSERT INTO personnel_qualification
          (tenant_id, employee_id, category_id, level_id, start_date, source_type, source_id, created_by, command_id)
          SELECT tenant_id, employee_id, category_id, level_id, start_date, 'manual', gen_random_uuid(), created_by, 'x'
          FROM personnel_qualification LIMIT 1`),
      ),
    ).rejects.toThrow();
  });

  it('同一次评定只写一次：evaluation_id 租户内唯一', async () => {
    const { w, s, tx, base } = await subsetScene(database, 'qs-eval-unique');
    const evaluationId = randomUUID();
    const save = () =>
      tx((t) =>
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
          base({ evaluationId }),
          undefined,
          false,
          { type: 'evaluation', id: randomUUID() },
        ),
      );
    await save();
    await expect(save()).rejects.toThrow();
  });
});

describe('AC-QL-subset 引用校验：类别 / 级别须对操作人可见且启用（DEC-352，只拦新引用）', () => {
  it('不存在 404；停用 400 REFERENCE_DISABLED；写入失败时不留行', async () => {
    const { add, rows, catalog } = await subsetScene(database, 'qs-refs');
    const missing = await add({ categoryId: randomUUID() });
    expect(missing.status, await missing.clone().text()).toBe(404);
    const disabledCategory = await add({ categoryId: catalog.disabledCategory.id });
    expect(disabledCategory.status).toBe(400);
    expect(await reasonOf(disabledCategory)).toBe('REFERENCE_DISABLED');
    const disabledLevel = await add({ levelId: catalog.disabledLevel.id });
    expect(disabledLevel.status).toBe(400);
    expect(await reasonOf(disabledLevel)).toBe('REFERENCE_DISABLED');
    expect((await add({ levelId: randomUUID() })).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('改类别 / 级别同样校验新引用；只改日期不重新校验已有引用（已引用后停用照常保留，DEC-281⑧）', async () => {
    const { w, path, addOk, rows, catalog } = await subsetScene(database, 'qs-refs-edit');
    const record = await addOk();
    const toDisabled = await w.request(w.hr.id, 'PATCH', `${path}/${record.id}`, {
      ifMatch: 1,
      body: { categoryId: catalog.disabledCategory.id },
    });
    expect(toDisabled.status).toBe(400);
    expect(await reasonOf(toDisabled)).toBe('REFERENCE_DISABLED');
    const changed = await w.request(w.hr.id, 'PATCH', `${path}/${record.id}`, {
      ifMatch: 1,
      body: { categoryId: catalog.otherCategory.id },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);

    // 已引用的类别事后停用：只改日期照常成功
    const klass = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `${QL_BASE}/categories/${catalog.otherCategory.id}`),
    );
    const disabled = await w.request(w.hr.id, 'PATCH', `${QL_BASE}/categories/${catalog.otherCategory.id}`, {
      ifMatch: klass.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const dated = await w.request(w.hr.id, 'PATCH', `${path}/${record.id}`, {
      ifMatch: 2,
      body: { endDate: '2027-01-01' },
    });
    expect(dated.status, await dated.clone().text()).toBe(200);
    expect((await rows())[0]).toMatchObject({ category_id: catalog.otherCategory.id, end_date: '2027-01-01' });
  });

  it('操作人没有类别 / 级别的查看权 → 403，数据不变（授权钩子按操作人判定）', async () => {
    const { w, path, add, rows, catalog } = await subsetScene(database, 'qs-refs-view');
    const { bindQualificationSubsetPolicy } = await import('../../apps/api/src/modules/qualification/subset-policy.js');
    const viewable = new Set<string>(['Qualification.EmploymentCategory', 'Qualification.EmploymentLevel']);
    // 模拟真实授权器对 Qualification 应用对象的判定：只认 object.view 的资源编码
    const authorize = ((request: { action: string; resource?: string }) =>
      request.action === 'object.view' ? viewable.has(request.resource ?? '') : true) as never;
    bindQualificationSubsetPolicy({ authorize, clock: w.clock });
    expect((await add()).status).toBe(201);
    const before = await rows();

    viewable.delete('Qualification.EmploymentCategory');
    const noCategory = await add({ categoryId: catalog.otherCategory.id });
    expect(noCategory.status, await noCategory.clone().text()).toBe(403);
    viewable.add('Qualification.EmploymentCategory');
    viewable.delete('Qualification.EmploymentLevel');
    const noLevel = await add({ levelId: catalog.otherLevel.id });
    expect(noLevel.status).toBe(403);
    // 只改日期不涉及新引用：不需要查看权
    const record = before[0]!;
    const dated = await w.request(w.hr.id, 'PATCH', `${path}/${String(record.id)}`, {
      ifMatch: 1,
      body: { endDate: '2027-02-02' },
    });
    expect(dated.status, await dated.clone().text()).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it('信息采集入口按同一策略校验（DEC-087）：停用类别 400，成功时来源 info_collection', async () => {
    const { w, s, tx, catalog, base, rows } = await subsetScene(database, 'qs-collect');
    const ctx = () => ({
      tenantId: w.tenant.id,
      userId: w.hr.id,
      timezone: 'Asia/Shanghai',
      now: w.clock(),
      commandId: randomUUID(),
      expectedRevision: 0,
    });
    await expect(
      tx((t) =>
        saveInformationCollection(
          t,
          ctx(),
          s.subject.employeeId,
          'qualification',
          randomUUID(),
          base({ categoryId: catalog.disabledCategory.id }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await rows()).toEqual([]);
    const saved = await tx((t) =>
      saveInformationCollection(t, ctx(), s.subject.employeeId, 'qualification', randomUUID(), base()),
    );
    expect(saved).toMatchObject({ sourceType: 'info_collection' });
  });
});

describe('AC-QL-subset SW74：自动同步的行改删锁定（DEC-331③ 追溯，实时判断）', () => {
  it('SW74 关：自动行改 / 删 409 QUALIFICATION_SUBSET_LOCKED、数据不变；手工行照常；恢复后可改', async () => {
    const { w, path, addOk, autoRow, rows, setSetting, count } = await subsetScene(database, 'qs-sw74');
    const auto = await autoRow();
    const manual = await addOk({ startDate: '2025-01-01' });
    const autoId = String(auto.id);

    const off = await setSetting(SETTING_EDITABLE, false, 0);
    const before = await rows();
    const audits = await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${autoId}`);
    const patched = await w.request(w.hr.id, 'PATCH', `${path}/${autoId}`, {
      ifMatch: 1,
      body: { endDate: '2026-06-30' },
    });
    expect(patched.status, await patched.clone().text()).toBe(409);
    expect(await reasonOf(patched)).toBe('QUALIFICATION_SUBSET_LOCKED');
    const removed = await w.request(w.hr.id, 'DELETE', `${path}/${autoId}`, { ifMatch: 1 });
    expect(removed.status).toBe(409);
    expect(await reasonOf(removed)).toBe('QUALIFICATION_SUBSET_LOCKED');
    expect(await rows()).toEqual(before);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${autoId}`)).toBe(audits);

    // 手工录入的不受影响
    const manualPatch = await w.request(w.hr.id, 'PATCH', `${path}/${manual.id}`, {
      ifMatch: manual.revision,
      body: { endDate: '2025-12-31' },
    });
    expect(manualPatch.status, await manualPatch.clone().text()).toBe(200);

    // 恢复后自动行可改（追溯：开关恢复即恢复，不存快照）
    await setSetting(SETTING_EDITABLE, true, off.revision);
    const restored = await w.request(w.hr.id, 'PATCH', `${path}/${autoId}`, {
      ifMatch: 1,
      body: { endDate: '2026-06-30' },
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
  });

  it('系统来源的写入（任职同步 / 评定）不受该开关约束：SW74 关时 employment_sync 仍可更新自己生成的行', async () => {
    const { w, s, tx, autoRow, setSetting } = await subsetScene(database, 'qs-sw74-sources');
    const auto = await autoRow();
    await setSetting(SETTING_EDITABLE, false, 0);
    const refreshed = await tx((t) =>
      saveSubset(
        t,
        {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          timezone: 'Asia/Shanghai',
          now: w.clock(),
          commandId: randomUUID(),
          expectedRevision: 1,
        },
        s.subject.employeeId,
        'qualification',
        { endDate: '2026-09-30' },
        String(auto.id),
        false,
        { type: 'employment_sync', id: randomUUID() },
      ),
    );
    expect(refreshed).toMatchObject({ endDate: '2026-09-30', revision: 2 });
  });
});

describe('AC-QL-subset 自助不开放 🟡（Q-M0-133 剩余，DEC-365③）', () => {
  it('首次提交与改已有记录的申请一律 403，不留申请行 / 版本 / 审批实例 / 申请审计', async () => {
    const q = await subsetScene(database, 'qs-self');
    const { w, s, catalog, addOk, count } = q;
    const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { qualification: ['categoryId', 'levelId', 'startDate', 'endDate'] } },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const record = await addOk();
    const footprint = async () => ({
      requests: await count(sql`SELECT count(*)::int AS n FROM personnel_change_requests`),
      versions: await count(sql`SELECT count(*)::int AS n FROM personnel_change_request_versions`),
      instances: await count(sql`SELECT count(*)::int AS n FROM approval_instances`),
      audits: await count(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = ${PERSONNEL_REQUEST_OBJECT}`,
      ),
    });
    const before = await footprint();
    const submit = (body: Record<string, unknown>) =>
      w.request(s.subject.userId, 'POST', REQUESTS, {
        ifMatch: 0,
        body: { employeeId: s.subject.employeeId, subset: 'qualification', ...body },
      });
    const first = await submit({
      values: { categoryId: catalog.category.id, levelId: catalog.level.id, startDate: '2026-02-01' },
    });
    expect(first.status, await first.clone().text()).toBe(403);
    expect(await reasonOf(first)).toBe('QUALIFICATION_SELF_SERVICE_CLOSED');
    const edit = await submit({
      recordId: record.id,
      targetRevision: record.revision,
      values: { endDate: '2026-12-31' },
    });
    expect(edit.status).toBe(403);
    expect(await footprint()).toEqual(before);
  });

  it('落地前复核：source = self_service 一律 403，子集与审计都不变', async () => {
    const { w, s, tx, base, rows, count } = await subsetScene(database, 'qs-self-save');
    const audits = () =>
      count(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = 'TenantBase.Qualification'`);
    const before = await audits();
    await expect(
      tx((t) =>
        saveSubset(
          t,
          {
            tenantId: w.tenant.id,
            userId: s.subject.userId,
            timezone: 'Asia/Shanghai',
            now: w.clock(),
            commandId: randomUUID(),
            expectedRevision: 0,
          },
          s.subject.employeeId,
          'qualification',
          base(),
          undefined,
          false,
          { type: 'self_service', id: randomUUID() },
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'QUALIFICATION_SELF_SERVICE_CLOSED' } });
    expect(await rows()).toEqual([]);
    expect(await audits()).toBe(before);
  });

  it('夹具直接插一张待审批的 qualification 申请，审批中心以 {} 重提 → 403，申请状态 / revision / 版本 / 审计不变', async () => {
    const { w, s, tx } = await subsetScene(database, 'qs-resubmit');
    const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school'], qualification: ['categoryId', 'levelId', 'startDate'] } },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    await w.publishedProcess({
      approvalType: 'personnel_change',
      priority: 1,
      conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
      nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school'] }],
    });
    const created = await w.request(s.subject.userId, 'POST', REQUESTS, {
      ifMatch: 0,
      body: { employeeId: s.subject.employeeId, subset: 'education', values: { school: '乙校' } },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const request = (await created.json()) as { id: string };
    const view = await w.instanceOf(request.id, s.subject.userId);
    const task = view.tasks.find((candidate) => candidate.status === 'pending')!;
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, task.id, 'reject', view.revision, { comment: '再看看' }),
    );
    expect(returned.status).toBe('returned');
    // 夹具：把这张待审批申请改成 qualification 子集（自助入口已不可能产生它）
    const values = { categoryId: randomUUID(), levelId: randomUUID(), startDate: '2026-02-01' };
    // 可信夹具：以库所有者身份改（应用角色对申请表只有 status / revision 的更新权；载荷以最新版本为准）。
    // 真 PG 上表启用了强制行级安全，所有者也要带租户上下文；改不到行就让用例失败，不静默跳过。
    const payload = JSON.stringify(values);
    await w.db.transaction(async (t) => {
      await t.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
      const changed = rowsOf<{ id: string }>(
        await t.execute(sql`UPDATE personnel_change_requests SET subset = 'qualification', values = ${payload}::jsonb
          WHERE id = ${request.id}::uuid RETURNING id`),
      );
      const versions = rowsOf<{ id: string }>(
        await t.execute(sql`UPDATE personnel_change_request_versions SET values = ${payload}::jsonb
          WHERE request_id = ${request.id}::uuid RETURNING id`),
      );
      expect([changed.length, versions.length]).toEqual([1, 1]);
    });
    const state = () =>
      tx(async (t) => ({
        request: rowsOf<{ status: string; revision: number }>(
          await t.execute(sql`SELECT status, revision FROM personnel_change_requests WHERE id = ${request.id}::uuid`),
        )[0],
        versions: Number(
          rowsOf<{ n: number }>(
            await t.execute(sql`SELECT count(*)::int AS n FROM personnel_change_request_versions
              WHERE request_id = ${request.id}::uuid`),
          )[0]!.n,
        ),
        audits: Number(
          rowsOf<{ n: number }>(
            await t.execute(
              sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = ${PERSONNEL_REQUEST_OBJECT}`,
            ),
          )[0]!.n,
        ),
      }));
    const before = await state();
    expect(before.request).toMatchObject({ status: 'pending_approval' });
    const denied = await w.request(s.subject.userId, 'POST', `${APPROVAL}/instances/${view.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: {} },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await reasonOf(denied)).toBe('QUALIFICATION_SELF_SERVICE_CLOSED');
    expect(await state()).toEqual(before);
    expect((await w.detail(view.id, s.subject.userId)).status).toBe('returned');
  });
});

describe('AC-QL-subset SW73 / SW74 系统预置开关（全局行，两层配置；不进种子补装登记表）', () => {
  it('迁移种子：键、默认值（SW73 关 / SW74 开，照原站租户）、可覆盖，与领域常量一致', async () => {
    const { tx } = await subsetScene(database, 'qs-settings');
    const seeded = await tx(async (t) =>
      rowsOf<{ key: string; value: unknown; description: string; overridable: boolean }>(
        await t.execute(sql`SELECT key, value, description, overridable FROM system_settings
          WHERE key LIKE 'qualification.%' ORDER BY key`),
      ),
    );
    expect(seeded.map((row) => row.key)).toEqual(Object.keys(QUALIFICATION_SETTINGS).sort());
    for (const row of seeded) {
      const spec = QUALIFICATION_SETTINGS[row.key as keyof typeof QUALIFICATION_SETTINGS];
      expect(row.value).toBe(spec.defaultValue);
      expect(row.description).toBe(spec.description);
      expect(row.overridable).toBe(true);
    }
    expect(QUALIFICATION_SETTINGS[SETTING_SYNC as keyof typeof QUALIFICATION_SETTINGS].defaultValue).toBe(false);
    expect(QUALIFICATION_SETTINGS[SETTING_EDITABLE as keyof typeof QUALIFICATION_SETTINGS].defaultValue).toBe(true);
  });

  it('SW73 设置页提示：关闭后所有任职变更都不再同步任职资格（P-2 ①）', () => {
    expect(QUALIFICATION_SETTINGS[SETTING_SYNC as keyof typeof QUALIFICATION_SETTINGS].hint).toBe(
      '关闭后所有任职变更都不再同步任职资格',
    );
  });

  it('经 PUT /api/tenant/settings/:key 覆盖：布尔值通过，其他类型 400 SETTING_VALUE_INVALID；恢复后回到系统值', async () => {
    const { w } = await subsetScene(database, 'qs-settings-write');
    const path = (key: string) => `/api/tenant/settings/${key}`;
    for (const key of [SETTING_SYNC, SETTING_EDITABLE]) {
      for (const value of ['true', 1, {}, []]) {
        const response = await w.request(w.hr.id, 'PUT', path(key), { ifMatch: 0, body: { value } });
        expect(response.status, `${key}=${JSON.stringify(value)}`).toBe(400);
        expect(await reasonOf(response)).toBe('SETTING_VALUE_INVALID');
      }
    }
    const on = await w.json<{ value: unknown; source: string; revision: number }>(
      await w.request(w.hr.id, 'PUT', path(SETTING_SYNC), { ifMatch: 0, body: { value: true } }),
    );
    expect(on).toMatchObject({ value: true, source: 'tenant', revision: 1 });
    const restored = await w.json<{ value: unknown; source: string }>(
      await w.request(w.hr.id, 'DELETE', `${path(SETTING_SYNC)}/override`, { ifMatch: 1 }),
    );
    expect(restored).toMatchObject({ value: false, source: 'system' });
  });
});

describe('AC-QL-subset 引用保护与租户隔离', () => {
  it('类别 / 级别被子集记录引用时不能删除（409 CATEGORY_IN_USE / LEVEL_IN_USE），数据不变', async () => {
    const { w, addOk, catalog } = await subsetScene(database, 'qs-in-use');
    await addOk();
    const category = await w.request(w.hr.id, 'DELETE', `${QL_BASE}/categories/${catalog.category.id}`, {
      ifMatch: catalog.category.revision,
    });
    expect(category.status, await category.clone().text()).toBe(409);
    expect(await reasonOf(category)).toBe('CATEGORY_IN_USE');
    const level = await w.request(w.hr.id, 'DELETE', `${QL_BASE}/levels/${catalog.level.id}`, {
      ifMatch: catalog.level.revision,
    });
    expect(level.status).toBe(409);
    expect(await reasonOf(level)).toBe('LEVEL_IN_USE');
  });

  it('子集表与版本表启用行级安全，版本表只追加（UPDATE / DELETE 被拒）', async () => {
    const { tx, addOk } = await subsetScene(database, 'qs-isolation');
    await addOk();
    const flags = await tx(async (t) =>
      rowsOf<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        await t.execute(sql`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('personnel_qualification', 'personnel_qualification_versions') ORDER BY relname`),
      ),
    );
    expect(flags.map((flag) => [flag.relname, flag.relrowsecurity])).toEqual([
      ['personnel_qualification', true],
      ['personnel_qualification_versions', true],
    ]);
    await expect(
      tx((t) => t.execute(sql`UPDATE personnel_qualification_versions SET command_id = 'x'`)),
    ).rejects.toThrow();
    await expect(tx((t) => t.execute(sql`DELETE FROM personnel_qualification_versions`))).rejects.toThrow();
  });
});
