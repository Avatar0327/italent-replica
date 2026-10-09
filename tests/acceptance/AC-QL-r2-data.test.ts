/**
 * R3-T02 PR-A 第 2 轮（审查 P2-06、08～10、12、13：数据正确性）：
 * - P2-06 旧状态不得覆盖新状态（DEC-067）：标准导入逐标准带预期 revision，任一不符整体 409；编码规则自动推进序号时
 *   revision 同步 + 1，拿旧 revision 的保存 409（四项编码规则同一实现）；
 * - P2-08 编码规则前缀与编码约束一致（QL-R3）：`_`、`-` 开头的前缀 400；库里已有不可用前缀时自动编码 400 而不是 500；
 * - P2-09 横向发展通道不能通往本类别（QL-R13）；
 * - P2-10 停用既有关联层级后原样保存级别照常成功（只拦新引用，DEC-281⑧）；
 * - P2-12 引入 / 导入登记任务级操作日志，成功与失败都留痕（DEC-199）；
 * - P2-13 删除 / 覆盖的子数据进快照（DEC-019）：删除等级方案含软删明细与遗留手改描述；通用覆盖含原格定位与各项值。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type GradeSchemeView, qualificationWorld, type StandardView, type TargetView } from './AC-QL-support.js';

const testDb = useTestDb();

const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

async function query<T>(db: Db, tenantId: string, statement: ReturnType<typeof sql>) {
  return withTenant(db, tenantId, async (tx) => rows<T>(await tx.execute(statement)));
}

async function gridWorld(label: string) {
  const w = await qualificationWorld(testDb().db, label);
  const klass = await w.categoryClass();
  const type = await w.targetType();
  const level = await w.level(10);
  return { w, klass, type, level };
}

const reason = async (response: Response) =>
  ((await response.clone().json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason;

describe('P2-06 旧状态不得覆盖新状态', () => {
  it('标准导入逐标准带预期 revision：旧 revision 409 整体不导入；缺少某标准的 revision 400', async () => {
    const { w, klass, type, level } = await gridWorld('ql-r2-import-rev');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const standard = await w.standard({
      categoryId: category.id,
      levelIds: [level.id],
      details: [{ levelId: level.id, targetId: target.id, abilities: [{ content: '原内容' }] }],
    });
    const renamed = await w.patch<StandardView>(`/standards/${standard.id}`, standard.revision, { name: '他人改名' });
    const row = { categoryCode: category.code, levelCode: level.code, targetCode: target.code, content: '旧内容覆盖' };
    const stale = await w.request('POST', '/standards/import', {
      body: { standards: [{ categoryCode: category.code, revision: standard.revision }], rows: [row] },
    });
    expect(stale.status, await stale.clone().text()).toBe(409);
    const missing = await w.request('POST', '/standards/import', { body: { standards: [], rows: [row] } });
    expect(missing.status, await missing.clone().text()).toBe(400);
    const after = await w.read<StandardView>(`/standards/${standard.id}`);
    expect(after.revision).toBe(renamed.revision);
    expect(after.details[0]!.abilities.map((a) => a.content)).toEqual(['原内容']);
    const fresh = await w.request('POST', '/standards/import', {
      body: { standards: [{ categoryCode: category.code, revision: renamed.revision }], rows: [row] },
    });
    expect(fresh.status, await fresh.clone().text()).toBe(200);
  });

  it('编码规则：自动编码推进序号时 revision + 1，拿旧 revision 保存 409（四项）', async () => {
    const { w, klass, type } = await gridWorld('ql-r2-coding-rev');
    const creators: Record<string, () => Promise<Response>> = {
      category: () => w.request('POST', '/categories', { ifMatch: 0, body: { name: '自动类别', classId: klass.id } }),
      level: () => w.request('POST', '/levels', { ifMatch: 0, body: { name: '自动级别' } }),
      target_type: () => w.request('POST', '/target-types', { ifMatch: 0, body: { name: '自动类型' } }),
      target: () =>
        w.request('POST', '/targets', { ifMatch: 0, body: { name: '自动指标', typeId: type.id, evalMode: 'score' } }),
    };
    for (const [item, create] of Object.entries(creators)) {
      const enabled = await w.request('PATCH', `/coding-rules/${item}`, {
        ifMatch: 0,
        body: { enabled: true, prefix: `A${item.length}` },
      });
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const created = await create();
      expect(created.status, await created.clone().text()).toBe(201);
      expect(((await created.json()) as { code: string }).code).toBe(`A${item.length}1`);
      const rules = await w.read<{ items: { item: string; revision: number; nextSeq: number }[] }>('/coding-rules');
      expect(rules.items.find((rule) => rule.item === item)).toMatchObject({ revision: 2, nextSeq: 2 });
      const stale = await w.request('PATCH', `/coding-rules/${item}`, { ifMatch: 1, body: { nextSeq: 1 } });
      expect(stale.status, item).toBe(409);
    }
  });
});

describe('P2-08 编码规则前缀与编码约束一致（QL-R3）', () => {
  it('以 _ 或 - 开头的前缀 400；库里已有不可用前缀时四类对象的自动编码 400（不是 500）', async () => {
    const { w, klass, type } = await gridWorld('ql-r2-prefix');
    for (const prefix of ['_', '-A', '_X']) {
      const response = await w.request('PATCH', '/coding-rules/category', {
        ifMatch: 0,
        body: { enabled: true, prefix },
      });
      expect(response.status, prefix).toBe(400);
    }
    // 库里遗留的不可用前缀（如早期数据）：自动编码给出明确的 400
    for (const item of ['category', 'level', 'target_type', 'target']) {
      await withTenant(testDb().db, w.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO ql_coding_rules (tenant_id, item, enabled, prefix, created_by)
          VALUES (${w.tenant.id}, ${item}, true, '_', ${w.user.id})
          ON CONFLICT (tenant_id, item) DO UPDATE SET enabled = true, prefix = '_'`),
      );
    }
    const attempts = [
      w.request('POST', '/categories', { ifMatch: 0, body: { name: '类别', classId: klass.id } }),
      w.request('POST', '/levels', { ifMatch: 0, body: { name: '级别' } }),
      w.request('POST', '/target-types', { ifMatch: 0, body: { name: '类型' } }),
      w.request('POST', '/targets', { ifMatch: 0, body: { name: '指标', typeId: type.id, evalMode: 'score' } }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await reason(response)).toBe('CODE_INVALID');
    }
  });
});

describe('P2-09 横向发展通道不能通往本类别（QL-R13）', () => {
  it('目标类别等于本标准的类别：同级与本类别其他级别都 400', async () => {
    const { w, klass, level } = await gridWorld('ql-r2-self-loop');
    const other = await w.level(20);
    const category = await w.category(klass.id);
    const standard = await w.standard({ categoryId: category.id, levelIds: [level.id, other.id], details: [] });
    for (const targetLevelId of [level.id, other.id]) {
      const response = await w.request('PUT', `/standards/${standard.id}/channels`, {
        ifMatch: standard.revision,
        body: { channels: [{ levelId: level.id, targetCategoryId: category.id, targetLevelId }] },
      });
      expect(response.status).toBe(400);
      expect(await reason(response)).toBe('CHANNEL_SELF_LOOP');
    }
  });
});

describe('P2-10 停用既有关联层级后原样保存级别（只拦新引用）', () => {
  it('级别已关联层级 A，A 停用后带回原 layerId 修改名称 200；改关联到另一个停用层级 400', async () => {
    const w = await qualificationWorld(testDb().db, 'ql-r2-layer');
    const layer = await w.created<{ id: string; revision: number }>('/layers', { name: '层级甲' });
    const another = await w.created<{ id: string; revision: number }>('/layers', { name: '层级乙', enabled: false });
    const level = await w.level(10, { layerId: layer.id });
    await w.patch(`/layers/${layer.id}`, layer.revision, { enabled: false });
    const kept = await w.request('PATCH', `/levels/${level.id}`, {
      ifMatch: level.revision,
      body: { name: '改名', layerId: layer.id },
    });
    expect(kept.status, await kept.clone().text()).toBe(200);
    const moved = await w.request('PATCH', `/levels/${level.id}`, {
      ifMatch: level.revision + 1,
      body: { layerId: another.id },
    });
    expect(moved.status).toBe(400);
    expect(await reason(moved)).toBe('REFERENCE_DISABLED');
  });
});

describe('P2-12 引入 / 导入登记任务级操作日志（DEC-199）', () => {
  const logs = (db: Db, tenantId: string, objectType: string) =>
    query<{ success_count: number; failure_count: number; behavior: string }>(
      db,
      tenantId,
      sql`SELECT behavior, success_count, failure_count FROM audit_operation_logs
        WHERE tenant_id = ${tenantId}::uuid AND object_type = ${objectType}
        ORDER BY success_count DESC, failure_count`,
    );

  it('类别引入、级别引入、标准明细导入：成功与失败各留一条任务日志（条数与结果）', async () => {
    const { w, klass, type, level } = await gridWorld('ql-r2-import-log');
    const sequence = await w.sequence('日志序列');
    const ok = await w.request('POST', '/categories/import', {
      ifMatch: 0,
      body: { classId: klass.id, jobLinkType: 'sequence', items: [{ jobObjectId: sequence }] },
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const failed = await w.request('POST', '/categories/import', {
      ifMatch: 0,
      body: { classId: klass.id, jobLinkType: 'sequence', items: [{ jobObjectId: crypto.randomUUID() }] },
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const categoryCode = QUALIFICATION_OBJECTS.category.code;
    expect(await logs(testDb().db, w.tenant.id, categoryCode)).toEqual([
      { behavior: 'import', success_count: 1, failure_count: 0 },
      { behavior: 'import', success_count: 0, failure_count: 1 },
    ]);

    const levelFailed = await w.request('POST', '/levels/import', {
      ifMatch: 0,
      body: { jobLinkType: 'level', items: [{ jobObjectId: crypto.randomUUID() }] },
    });
    expect(levelFailed.status).toBeGreaterThanOrEqual(400);
    expect(await logs(testDb().db, w.tenant.id, QUALIFICATION_OBJECTS.level.code)).toEqual([
      { behavior: 'import', success_count: 0, failure_count: 1 },
    ]);

    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const standard = await w.standard({ categoryId: category.id, levelIds: [level.id], details: [] });
    const row = { categoryCode: category.code, levelCode: level.code, targetCode: target.code, content: '导入' };
    const imported = await w.request('POST', '/standards/import', {
      body: { standards: [{ categoryCode: category.code, revision: standard.revision }], rows: [row, row] },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    const rejected = await w.request('POST', '/standards/import', {
      body: {
        standards: [{ categoryCode: category.code, revision: standard.revision + 1 }],
        rows: [row, { ...row, targetCode: 'NO-SUCH' }],
      },
    });
    expect(rejected.status).toBe(400);
    expect(await logs(testDb().db, w.tenant.id, QUALIFICATION_OBJECTS.standard.code)).toEqual([
      { behavior: 'import', success_count: 2, failure_count: 0 },
      { behavior: 'import', success_count: 0, failure_count: 2 },
    ]);
  });
});

describe('P2-13 删除 / 覆盖的子数据进快照（DEC-019）', () => {
  const audits = (db: Db, tenantId: string, objectType: string, objectId: string, action: string) =>
    query<{ before: unknown; after: unknown }>(
      db,
      tenantId,
      sql`SELECT before, after FROM audit_events WHERE tenant_id = ${tenantId}::uuid AND object_type = ${objectType}
        AND object_id = ${objectId} AND action = ${action} ORDER BY occurred_at, id`,
    );

  it('删除等级方案：快照含软删的明细；旧方案上遗留的手改描述另写删除审计', async () => {
    const { w, type } = await gridWorld('ql-r2-scheme-snapshot');
    const scheme = await w.gradeScheme([
      { name: '保留级', grade: 1, description: '保留' },
      { name: '软删级', grade: 2, description: '软删' },
    ]);
    const next = await w.gradeScheme([{ name: '新方案级', grade: 1 }]);
    const target = await w.target(type.id, { evalMode: 'grade', gradeSchemeId: scheme.id });
    await w
      .request('PUT', `/targets/${target.id}/grade-descriptions/${scheme.details[0]!.id}`, {
        ifMatch: target.revision,
        body: { description: '遗留手改' },
      })
      .then((r) => w.ok(r));
    const moved = await w.read<TargetView>(`/targets/${target.id}`);
    await w.patch(`/targets/${target.id}`, moved.revision, { gradeSchemeId: next.id });
    const trimmed = await w.patch<GradeSchemeView>(`/grade-schemes/${scheme.id}`, scheme.revision, {
      details: [{ id: scheme.details[0]!.id, name: '保留级', grade: 1, description: '保留' }],
    });
    const deleted = await w.request('DELETE', `/grade-schemes/${scheme.id}`, { ifMatch: trimmed.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const [schemeAudit] = await audits(
      testDb().db,
      w.tenant.id,
      QUALIFICATION_OBJECTS.gradeScheme.code,
      scheme.id,
      'qualification.grade-scheme.delete',
    );
    expect(JSON.stringify(schemeAudit!.before)).toContain('软删级');
    const leftovers = await audits(
      testDb().db,
      w.tenant.id,
      QUALIFICATION_OBJECTS.targetGradeDescription.code,
      target.id,
      'qualification.target-grade-description.delete',
    );
    expect(JSON.stringify(leftovers.map((entry) => entry.before))).toContain('遗留手改');
  });

  it('非通用改通用：覆盖审计的 before 含格定位、指标值、权重与各条能力标准的各项值', async () => {
    const { w, klass, type, level } = await gridWorld('ql-r2-overwrite-snapshot');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const standard = await w.standard({
      categoryId: category.id,
      levelIds: [level.id],
      details: [
        {
          levelId: level.id,
          targetId: target.id,
          targetValue: '格目标值',
          weight: 40,
          abilities: [{ content: '原能力', targetValue: '能力目标值', weight: 25 }],
        },
      ],
    });
    await w.patch(`/targets/${target.id}`, target.revision, { isCommon: true, confirmOverwrite: true });
    const [entry] = await audits(
      testDb().db,
      w.tenant.id,
      QUALIFICATION_OBJECTS.standard.code,
      standard.id,
      'qualification.standard.common-overwrite',
    );
    const before = JSON.stringify(entry!.before);
    for (const value of [level.id, target.id, '格目标值', '40', '原能力', '能力目标值', '25']) {
      expect(before, value).toContain(value);
    }
    expect((entry!.before as Record<string, unknown>).details).toBeDefined();
  });
});
