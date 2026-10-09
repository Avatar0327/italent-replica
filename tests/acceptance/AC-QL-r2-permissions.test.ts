/**
 * R3-T02 PR-A 第 2 轮（审查 P2-01～05、P2-11，真实授权器）：
 * - P2-01 幂等重放按当前范围复核（DEC-067）：类别 / 级别引入、等级描述 PUT、编码规则 PATCH、标准导入、发展通道 PUT；
 * - P2-02 专项响应按字段与源对象裁剪（DEC-309）：等级描述 PUT、编码规则 PATCH、发展通道 GET、图谱；
 * - P2-03 关联冲突提示不带出看不到的岗职务编码与范围外对象名称（DEC-331④）：类别 / 级别的新建、修改、引入；
 * - P2-04 改关联类型派生的清空关联同样要 jobLinks 编辑权；
 * - P2-05 审计按查看人当前的源字段权裁剪（DEC-197 / DEC-309）：通用指标说明、等级描述的投影值；
 * - P2-11 通用指标覆盖、发展通道变更的审计对正常审计员可见（变化字段对得上字段目录）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { code, type Data, operator, type Operator, reasonOf, seed } from './AC-QL-perm-support.js';
import { type CategoryView, type GradeSchemeView, type LevelView, QL_NOW, type StandardView } from './AC-QL-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('任职资格配置第 2 轮：权限与裁剪', () => {
  let world: PermissionWorld;
  let data: Data;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
  });

  const ok = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  };
  const job = async (kind: 'sequences' | 'levels') => {
    const jobCode = code('J');
    const body =
      kind === 'sequences'
        ? { name: `序列${jobCode}`, code: jobCode, startDate: '2020-01-01' }
        : { name: `职级${jobCode}`, code: jobCode, level: 9, levelTypeId: data.levelTypeId, startDate: '2020-01-01' };
    const created = await ok<{ id: string }>(
      await data.admin('POST', `/api/tenant/job/${kind}`, { ifMatch: 0, body }),
      201,
    );
    return { id: created.id, code: jobCode };
  };
  /** 管理员在下级部建一套可供下级管理员编辑的对象。 */
  const childSet = async () => {
    const create = await data.adminIn(data.child);
    const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '下级分类' });
    const category = await create<CategoryView>('/categories', { code: code(), name: '下级类别', classId: klass.id });
    const other = await create<CategoryView>('/categories', { code: code(), name: '下级他类', classId: klass.id });
    const levelCode = code('L');
    const level = await create<LevelView>('/levels', { code: levelCode, name: '下级级别' });
    const targetCode = code('T');
    const target = await create<{ id: string }>('/targets', {
      code: targetCode,
      name: '下级指标',
      typeId: data.typeId,
      evalMode: 'score',
    });
    const standard = await create<StandardView>('/standards', {
      categoryId: category.id,
      name: '下级标准',
      levelIds: [level.id],
      details: [{ levelId: level.id, targetId: target.id }],
    });
    return { create, klass, category, other, level, levelCode, target, targetCode, standard };
  };
  const childOp = (extra: Parameters<typeof operator>[1] = {}) => operator(world, { mouId: data.childMou, ...extra });

  describe('P2-01 幂等重放按当前范围复核（DEC-067）', () => {
    /** 首次成功，撤销范围后同键同内容重放：与不存在同一个 404。 */
    const replayAfterRevoke = async (
      op: Operator,
      method: string,
      path: string,
      options: { ifMatch?: number; body: unknown },
      revoke: () => Promise<void> = op.revoke,
    ) => {
      const idempotencyKey = randomUUID();
      const first = await op.request(method, path, { ...options, idempotencyKey });
      expect(first.status, await first.clone().text()).toBeLessThan(300);
      await revoke();
      const replay = await op.request(method, path, { ...options, idempotencyKey });
      expect(replay.status, await replay.clone().text()).toBe(404);
    };

    it('引入任职类别 / 级别', async () => {
      const sequence = await job('sequences');
      const op = await childOp({ sequenceHidden: [] });
      const klass = await ok<{ id: string }>(
        await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: code(), name: '分类' } }),
        201,
      );
      await replayAfterRevoke(op, 'POST', '/categories/import', {
        ifMatch: 0,
        body: { classId: klass.id, jobLinkType: 'sequence', items: [{ jobObjectId: sequence.id }] },
      });
      const jobLevel = await job('levels');
      const op2 = await childOp({ sequenceHidden: [] });
      await replayAfterRevoke(op2, 'POST', '/levels/import', {
        ifMatch: 0,
        body: { jobLinkType: 'level', items: [{ jobObjectId: jobLevel.id }] },
      });
    });

    it('指标等级描述 PUT', async () => {
      const create = await data.adminIn(data.child);
      const target = await create<{ id: string; revision: number }>('/targets', {
        code: code(),
        name: '下级评级指标',
        typeId: data.typeId,
        evalMode: 'grade',
        gradeSchemeId: data.schemeId,
      });
      const scheme = await ok<GradeSchemeView>(await data.admin('GET', `/grade-schemes/${data.schemeId}`));
      await replayAfterRevoke(
        await childOp(),
        'PUT',
        `/targets/${target.id}/grade-descriptions/${scheme.details[0]!.id}`,
        {
          ifMatch: target.revision,
          body: { description: '手改' },
        },
      );
    });

    it('编码规则 PATCH', async () => {
      const op = await childOp({ seeAll: true });
      const rules = await ok<{ items: { item: string; revision: number }[] }>(await op.request('GET', '/coding-rules'));
      const rule = rules.items.find((item) => item.item === 'target_type')!;
      await replayAfterRevoke(
        op,
        'PATCH',
        '/coding-rules/target_type',
        { ifMatch: rule.revision, body: { enabled: true, prefix: 'TT' } },
        op.revokeSeeAll,
      );
    });

    it('标准明细导入', async () => {
      const set = await childSet();
      const category = await ok<CategoryView>(await data.admin('GET', `/categories/${set.category.id}`));
      await replayAfterRevoke(await childOp(), 'POST', '/standards/import', {
        body: {
          standards: [{ categoryCode: category.code, revision: set.standard.revision }],
          rows: [
            { categoryCode: category.code, levelCode: set.levelCode, targetCode: set.targetCode, content: '导入' },
          ],
        },
      });
    });

    it('发展通道 PUT', async () => {
      const set = await childSet();
      await replayAfterRevoke(await childOp(), 'PUT', `/standards/${set.standard.id}/channels`, {
        ifMatch: set.standard.revision,
        body: { channels: [{ levelId: set.level.id, targetCategoryId: set.other.id, targetLevelId: set.level.id }] },
      });
    });
  });

  describe('P2-02 专项响应按字段与源对象裁剪（DEC-309）', () => {
    it('等级描述 PUT 只回裁剪后的投影：看不到等级方案时，未手改的描述、名称、等级都不给', async () => {
      const create = await data.adminIn(data.child);
      const scheme = await create<GradeSchemeView>('/grade-schemes', {
        name: `方案${code()}`,
        details: [
          { name: '甲级', grade: 1, description: '甲描述' },
          { name: '乙级', grade: 2, description: '乙保密描述' },
        ],
      });
      const target = await create<{ id: string; revision: number }>('/targets', {
        code: code(),
        name: '两级指标',
        typeId: data.typeId,
        evalMode: 'grade',
        gradeSchemeId: scheme.id,
      });
      const op = await childOp();
      const body = await ok<{ items: Record<string, unknown>[] }>(
        await op.request('PUT', `/targets/${target.id}/grade-descriptions/${scheme.details[0]!.id}`, {
          ifMatch: target.revision,
          body: { description: '手改' },
        }),
      );
      expect(body.items[0]).toMatchObject({ description: '手改', modified: true });
      for (const key of ['description', 'name', 'grade']) expect(body.items[1]).not.toHaveProperty(key);
      expect(JSON.stringify(body)).not.toContain('乙保密描述');
    });

    it('编码规则 PATCH 的响应不回隐藏的前缀', async () => {
      const setup = await childOp({ seeAll: true });
      const rules = await ok<{ items: { item: string; revision: number }[] }>(
        await setup.request('GET', '/coding-rules'),
      );
      const level = rules.items.find((item) => item.item === 'level')!;
      await ok(
        await setup.request('PATCH', '/coding-rules/level', {
          ifMatch: level.revision,
          body: { prefix: 'SECRETP' },
        }),
      );
      const op = await childOp({ seeAll: true, hidden: { codingRule: ['prefix'] } });
      const listed = await ok<{ items: Record<string, unknown>[] }>(await op.request('GET', '/coding-rules'));
      expect(listed.items.find((item) => item.item === 'level')).not.toHaveProperty('prefix');
      const patched = await ok<Record<string, unknown>>(
        await op.request('PATCH', '/coding-rules/level', { ifMatch: level.revision + 1, body: { enabled: true } }),
      );
      expect(patched).not.toHaveProperty('prefix');
      expect(JSON.stringify(patched)).not.toContain('SECRETP');
    });

    it('发展通道 GET 按发展通道字段与目标对象的读取范围逐节点裁剪；纵向顺序号随级别的顺序号字段权', async () => {
      const set = await childSet();
      const updated = await ok<{ revision: number }>(
        await data.admin('PUT', `/standards/${set.standard.id}/channels`, {
          ifMatch: set.standard.revision,
          body: {
            channels: [
              { levelId: set.level.id, targetCategoryId: set.other.id, targetLevelId: set.level.id },
              // 目标类别在下级管理员读取范围外（上级部、不向下公开）
              { levelId: set.level.id, targetCategoryId: data.closed.id, targetLevelId: set.level.id },
            ],
          },
        }),
      );
      expect(updated.revision).toBe(set.standard.revision + 1);
      const hiddenField = await childOp({
        hidden: { developmentChannel: ['targetCategoryId'], level: ['displayOrder'] },
      });
      const trimmed = await ok<{
        vertical: Record<string, unknown>[];
        horizontal: Record<string, unknown>[];
      }>(await hiddenField.request('GET', `/standards/${set.standard.id}/channels`));
      for (const node of trimmed.horizontal) expect(node).not.toHaveProperty('targetCategoryId');
      for (const node of trimmed.vertical) expect(node).not.toHaveProperty('displayOrder');
      const normal = await childOp();
      const channels = await ok<{ horizontal: Record<string, unknown>[] }>(
        await normal.request('GET', `/standards/${set.standard.id}/channels`),
      );
      expect(JSON.stringify(channels)).not.toContain(data.closed.id);
      expect(channels.horizontal.some((node) => node.targetCategoryId === set.other.id)).toBe(true);
    });

    it('图谱：看不到级别范围、明细、级别描述与级别顺序号时，不从原始数据重建级别 ID 与顺序号', async () => {
      const set = await childSet();
      const op = await childOp({
        hidden: { standard: ['levelIds', 'details', 'levelDescriptions'], level: ['displayOrder'] },
      });
      const chart = await ok<Record<string, unknown>>(await op.request('GET', `/standards/${set.standard.id}/chart`));
      expect(JSON.stringify(chart)).not.toContain(set.level.id);
      expect(JSON.stringify(chart)).not.toContain('displayOrder');
    });
  });

  describe('P2-03 关联冲突提示（DEC-331④）不带出看不到的岗职务编码与范围外名称', () => {
    it('类别与级别的新建、修改、引入共 6 个入口：409 照拦，提示不含范围外名称与隐藏编码', async () => {
      const sequence = await job('sequences');
      const jobLevel = await job('levels');
      const outside = await data.adminIn(data.outside);
      const outsideClass = await outside<{ id: string }>('/category-classes', { code: code(), name: '外分类' });
      await outside('/categories', {
        code: code(),
        name: '范围外类别',
        classId: outsideClass.id,
        jobLinkType: 'sequence',
        jobLinks: [sequence.id],
      });
      await outside('/levels', { code: code(), name: '范围外级别', jobLinkType: 'level', jobLinks: [jobLevel.id] });

      const op = await childOp({ sequenceHidden: ['code'] });
      const klass = await ok<{ id: string }>(
        await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: code(), name: '分类' } }),
        201,
      );
      const bareCategory = await ok<CategoryView>(
        await op.request('POST', '/categories', {
          ifMatch: 0,
          body: { code: code(), name: '本人类别', classId: klass.id },
        }),
        201,
      );
      const bareLevel = await ok<LevelView>(
        await op.request('POST', '/levels', { ifMatch: 0, body: { code: code(), name: '本人级别' } }),
        201,
      );
      const attempts: [string, () => Promise<Response>][] = [
        [
          'category create',
          () =>
            op.request('POST', '/categories', {
              ifMatch: 0,
              body: {
                code: code(),
                name: '新类别',
                classId: klass.id,
                jobLinkType: 'sequence',
                jobLinks: [sequence.id],
              },
            }),
        ],
        [
          'category update',
          () =>
            op.request('PATCH', `/categories/${bareCategory.id}`, {
              ifMatch: bareCategory.revision,
              body: { jobLinkType: 'sequence', jobLinks: [sequence.id] },
            }),
        ],
        [
          'category import',
          () =>
            op.request('POST', '/categories/import', {
              ifMatch: 0,
              body: {
                classId: klass.id,
                jobLinkType: 'sequence',
                items: [{ jobObjectId: sequence.id, code: code(), name: '引入类别' }],
              },
            }),
        ],
        [
          'level create',
          () =>
            op.request('POST', '/levels', {
              ifMatch: 0,
              body: { code: code(), name: '新级别', jobLinkType: 'level', jobLinks: [jobLevel.id] },
            }),
        ],
        [
          'level update',
          () =>
            op.request('PATCH', `/levels/${bareLevel.id}`, {
              ifMatch: bareLevel.revision,
              body: { jobLinkType: 'level', jobLinks: [jobLevel.id] },
            }),
        ],
        [
          'level import',
          () =>
            op.request('POST', '/levels/import', {
              ifMatch: 0,
              body: { jobLinkType: 'level', items: [{ jobObjectId: jobLevel.id, code: code(), name: '引入级别' }] },
            }),
        ],
      ];
      for (const [label, attempt] of attempts) {
        const response = await attempt();
        expect(response.status, label).toBe(409);
        expect(await reasonOf(response), label).toBe('JOB_ALREADY_LINKED');
        const message = ((await response.json()) as { error: { message: string } }).error.message;
        for (const secret of ['范围外类别', '范围外级别', sequence.code, jobLevel.code]) {
          expect(message, label).not.toContain(secret);
        }
      }
    });

    it('看得到的冲突对象与岗职务编码照原站带出', async () => {
      const sequence = await job('sequences');
      const op = await childOp({ sequenceHidden: [] });
      const klass = await ok<{ id: string }>(
        await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: code(), name: '分类' } }),
        201,
      );
      const link = (name: string) =>
        op.request('POST', '/categories', {
          ifMatch: 0,
          body: { code: code(), name, classId: klass.id, jobLinkType: 'sequence', jobLinks: [sequence.id] },
        });
      expect((await link('先占类别')).status).toBe(201);
      const conflict = await link('后来类别');
      expect(conflict.status).toBe(409);
      const message = ((await conflict.json()) as { error: { message: string } }).error.message;
      expect(message).toContain('先占类别');
      expect(message).toContain(sequence.code);
    });
  });

  describe('P2-04 改关联类型派生的清空关联要 jobLinks 编辑权', () => {
    it('类别与级别：只有 jobLinkType 编辑权时改类型 / 清类型 403，关联不变', async () => {
      const sequence = await job('sequences');
      const jobLevel = await job('levels');
      const create = await data.adminIn(data.child);
      const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '分类' });
      const category = await create<CategoryView>('/categories', {
        code: code(),
        name: '已关联类别',
        classId: klass.id,
        jobLinkType: 'sequence',
        jobLinks: [sequence.id],
      });
      const level = await create<LevelView & { jobLinks: unknown[] }>('/levels', {
        code: code(),
        name: '已关联级别',
        jobLinkType: 'level',
        jobLinks: [jobLevel.id],
      });
      const op = await childOp({ readonly: { category: ['jobLinks'], level: ['jobLinks'] } });
      for (const body of [{ jobLinkType: null }, { jobLinkType: 'post' }]) {
        const response = await op.request('PATCH', `/categories/${category.id}`, { ifMatch: category.revision, body });
        expect(response.status, JSON.stringify(body)).toBe(403);
      }
      for (const body of [{ jobLinkType: null }, { jobLinkType: 'grade' }]) {
        const response = await op.request('PATCH', `/levels/${level.id}`, { ifMatch: level.revision, body });
        expect(response.status, JSON.stringify(body)).toBe(403);
      }
      const after = await ok<CategoryView>(await op.request('GET', `/categories/${category.id}`));
      expect(after.jobLinks).toEqual([{ jobObjectId: sequence.id }]);
      const afterLevel = await ok<{ jobLinks: unknown[] }>(await op.request('GET', `/levels/${level.id}`));
      expect(afterLevel.jobLinks).toEqual([{ jobObjectId: jobLevel.id }]);
    });
  });

  describe('P2-05 / P2-11 审计按当前源字段权裁剪，且对正常审计员可见', () => {
    const audit = () => auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
    const standardCode = QUALIFICATION_OBJECTS.standard.code;

    /** 某对象的全部审计（列表 + 详情）序列化，供检查是否出现某段文字。 */
    const auditText = async (op: Operator, objectType: string, objectId: string) => {
      const api = audit();
      const list = await api.dataChanges(op.as, { objectType, limit: '100' });
      const mine = list.items.filter((item) => item.objectId === objectId);
      const details = [];
      for (const item of mine) details.push(await api.dataChange(op.as, item.id));
      return { count: mine.length, text: JSON.stringify([mine, details]), actions: mine.map((item) => item.action) };
    };

    it('标准新建 / 修改 / 导入 / 删除的快照：看不到指标说明的审计员看不到通用指标覆盖的内容', async () => {
      const create = await data.adminIn(data.parent);
      const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '审计分类' });
      const category = await create<CategoryView>('/categories', { code: code(), name: '审计类别', classId: klass.id });
      const levelCode = code('L');
      const level = await create<{ id: string }>('/levels', { code: levelCode, name: '审计级别' });
      const targetCode = code('T');
      await create('/targets', { code: targetCode, name: '审计普通', typeId: data.typeId, evalMode: 'score' });
      const standard = await create<StandardView>('/standards', {
        categoryId: category.id,
        name: '审计标准',
        levelIds: [level.id],
        details: [{ levelId: level.id, targetId: data.commonTarget }],
      });
      const renamed = await ok<StandardView>(
        await data.admin('PATCH', `/standards/${standard.id}`, { ifMatch: standard.revision, body: { name: '改名' } }),
      );
      await ok(
        await data.admin('POST', '/standards/import', {
          body: {
            standards: [{ categoryCode: category.code, revision: renamed.revision }],
            rows: [{ categoryCode: category.code, levelCode, targetCode, content: '导入内容' }],
          },
        }),
      );
      const current = await ok<StandardView>(await data.admin('GET', `/standards/${standard.id}`));
      await ok(await data.admin('DELETE', `/standards/${standard.id}`, { ifMatch: current.revision }));

      const blind = await operator(world, {
        mouId: data.parentMou,
        auditor: true,
        hidden: { target: ['description'] },
      });
      const seen = await auditText(blind, standardCode, standard.id);
      expect(seen.actions.sort()).toEqual(
        ['create', 'delete', 'import', 'update'].map((op) => `qualification.standard.${op}`).sort(),
      );
      expect(seen.text).not.toContain('通用保密说明');
      const sighted = await operator(world, { mouId: data.parentMou, auditor: true });
      expect((await auditText(sighted, standardCode, standard.id)).text).toContain('通用保密说明');
    });

    it('等级描述首次手改的 before（等级明细描述的投影）：读不到等级方案的审计员看不到', async () => {
      const create = await data.adminIn(data.parent);
      const target = await create<{ id: string; revision: number }>('/targets', {
        code: code(),
        name: '审计评级',
        typeId: data.typeId,
        evalMode: 'grade',
        gradeSchemeId: data.schemeId,
      });
      const scheme = await ok<GradeSchemeView>(await data.admin('GET', `/grade-schemes/${data.schemeId}`));
      await ok(
        await data.admin('PUT', `/targets/${target.id}/grade-descriptions/${scheme.details[0]!.id}`, {
          ifMatch: target.revision,
          body: { description: '审计手改' },
        }),
      );
      const type = QUALIFICATION_OBJECTS.targetGradeDescription.code;
      const blind = await operator(world, { mouId: data.parentMou, auditor: true });
      const seen = await auditText(blind, type, target.id);
      expect(seen.count).toBeGreaterThan(0);
      expect(seen.text).toContain('审计手改');
      expect(seen.text).not.toContain('明细保密描述');
      const sighted = await operator(world, { mouId: data.parentMou, auditor: true, seeAll: true });
      expect((await auditText(sighted, type, target.id)).text).toContain('明细保密描述');
    });

    it('P2-11：通用指标覆盖写入、发展通道变更的审计对有全部字段的审计员可见', async () => {
      const target = await ok<{ revision: number }>(await data.admin('GET', `/targets/${data.commonTarget}`));
      await ok(
        await data.admin('PATCH', `/targets/${data.commonTarget}`, {
          ifMatch: target.revision,
          body: { description: '通用保密说明（改）', confirmOverwrite: true },
        }),
      );
      const create = await data.adminIn(data.parent);
      const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '通道分类' });
      const category = await create<CategoryView>('/categories', { code: code(), name: '通道类别', classId: klass.id });
      const level = await create<{ id: string }>('/levels', { code: code(), name: '通道级别' });
      const standard = await create<StandardView>('/standards', {
        categoryId: category.id,
        name: '通道标准',
        levelIds: [level.id],
        details: [],
      });
      await ok(
        await data.admin('PUT', `/standards/${standard.id}/channels`, {
          ifMatch: standard.revision,
          body: { channels: [{ levelId: level.id, targetCategoryId: data.open.id, targetLevelId: data.levelId }] },
        }),
      );
      const auditor = await operator(world, { mouId: data.parentMou, auditor: true });
      const overwrite = await auditText(auditor, standardCode, data.standardId);
      expect(overwrite.actions).toContain('qualification.standard.common-overwrite');
      const channels = await auditText(auditor, QUALIFICATION_OBJECTS.developmentChannel.code, standard.id);
      expect(channels.count).toBeGreaterThan(0);
      expect(channels.text).toContain(data.open.id);
    });
  });

  describe('P2-08 引入进入自动编码的分支（看不到岗职务编码且未填编码）', () => {
    it('库里遗留不可用前缀时，类别 / 级别引入给出 400 CODE_INVALID（不是 500）', async () => {
      for (const item of ['category', 'level']) {
        await withTenant(testDb().db, world.tenant.id, (tx) =>
          tx.execute(sql`INSERT INTO ql_coding_rules (tenant_id, item, enabled, prefix, created_by)
            VALUES (${world.tenant.id}, ${item}, true, '-', ${world.asAdmin.user})
            ON CONFLICT (tenant_id, item) DO UPDATE SET enabled = true, prefix = '-'`),
        );
      }
      const sequence = await job('sequences');
      const jobLevel = await job('levels');
      const op = await childOp({ sequenceHidden: ['code'] });
      const klass = await ok<{ id: string }>(
        await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: code(), name: '分类' } }),
        201,
      );
      const categories = await op.request('POST', '/categories/import', {
        ifMatch: 0,
        body: { classId: klass.id, jobLinkType: 'sequence', items: [{ jobObjectId: sequence.id }] },
      });
      const levels = await op.request('POST', '/levels/import', {
        ifMatch: 0,
        body: { jobLinkType: 'level', items: [{ jobObjectId: jobLevel.id }] },
      });
      for (const response of [categories, levels]) {
        expect(response.status, await response.clone().text()).toBe(400);
        expect(await reasonOf(response)).toBe('CODE_INVALID');
      }
    });
  });

  describe('DEC-347 已定口径', () => {
    it('① 建标准不要求类别查看权，只要类别在写范围内（🟡）', async () => {
      const create = await data.adminIn(data.child);
      const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '无权分类' });
      const category = await create<CategoryView>('/categories', { code: code(), name: '无权类别', classId: klass.id });
      const level = await create<{ id: string }>('/levels', { code: code(), name: '无权级别' });
      const op = await childOp({ noObject: ['category'] });
      expect((await op.request('GET', `/categories/${category.id}`)).status).toBe(403);
      const standard = await op.request('POST', '/standards', {
        ifMatch: 0,
        body: { categoryId: category.id, name: '无类别查看权的标准', levelIds: [level.id], details: [] },
      });
      expect(standard.status, await standard.clone().text()).toBe(201);
    });

    it('② 横向通道目的地没有标准、或目标级别不在该标准里：照常保存，逐条提示（🟡）；本类别自环仍拒绝', async () => {
      const set = await childSet();
      const withStandard = await set.create<CategoryView>('/categories', {
        code: code(),
        name: '有标准的目的地',
        classId: set.klass.id,
      });
      const destLevel = await set.create<{ id: string }>('/levels', { code: code(), name: '目的地级别' });
      await set.create('/standards', {
        categoryId: withStandard.id,
        name: '目的地标准',
        levelIds: [destLevel.id],
        details: [],
      });
      const op = await childOp();
      const saved = await ok<{ horizontal: unknown[]; warnings: { index: number; reason: string }[] }>(
        await op.request('PUT', `/standards/${set.standard.id}/channels`, {
          ifMatch: set.standard.revision,
          body: {
            channels: [
              { levelId: set.level.id, targetCategoryId: set.other.id, targetLevelId: set.level.id },
              { levelId: set.level.id, targetCategoryId: withStandard.id, targetLevelId: set.level.id },
              { levelId: set.level.id, targetCategoryId: withStandard.id, targetLevelId: destLevel.id },
            ],
          },
        }),
      );
      expect(saved.horizontal).toHaveLength(3);
      expect(saved.warnings).toEqual([
        { index: 0, reason: 'TARGET_STANDARD_MISSING' },
        { index: 1, reason: 'TARGET_LEVEL_NOT_IN_STANDARD' },
      ]);
      const loop = await op.request('PUT', `/standards/${set.standard.id}/channels`, {
        ifMatch: set.standard.revision + 1,
        body: { channels: [{ levelId: set.level.id, targetCategoryId: set.category.id, targetLevelId: set.level.id }] },
      });
      expect(loop.status).toBe(400);
      expect(await reasonOf(loop)).toBe('CHANNEL_SELF_LOOP');
    });

    it('③ 编码规则可见范围 = 看全部 ∪ 创建人：只有创建人维度时看得到自己建的、看不到别人的', async () => {
      // 别人（管理员）先建好“类别”这一项
      const rules = await ok<{ items: { item: string; revision: number }[] }>(await data.admin('GET', '/coding-rules'));
      const category = rules.items.find((item) => item.item === 'category')!;
      await ok(
        await data.admin('PATCH', '/coding-rules/category', {
          ifMatch: category.revision,
          body: { enabled: true, prefix: 'ADMIN' },
        }),
      );
      const codingRule = QUALIFICATION_OBJECTS.codingRule.code;
      const policy = await world.api.request(
        'PUT',
        `/api/tenant/permission/scope-policies/${'Qualification'}/${codingRule}/entity/${codingRule}`,
        { ...world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
      );
      expect(policy.status, await policy.clone().text()).toBe(200);
      const first = await operator(world, {});
      const second = await operator(world, {});
      const listed = async (op: Operator) =>
        (
          await ok<{ items: { item: string; prefix?: string; revision: number }[] }>(
            await op.request('GET', '/coding-rules'),
          )
        ).items;
      expect((await listed(first)).map((item) => item.item)).not.toContain('category');
      const blank = (await listed(first)).find((item) => item.item === 'target')!;
      await ok(
        await first.request('PATCH', '/coding-rules/target', { ifMatch: blank.revision, body: { prefix: 'MINE' } }),
      );
      expect((await listed(first)).find((item) => item.item === 'target')).toMatchObject({ prefix: 'MINE' });
      expect((await listed(second)).map((item) => item.item)).not.toContain('target');
      const foreign = await second.request('PATCH', '/coding-rules/target', { ifMatch: 1, body: { prefix: 'THEIRS' } });
      expect(foreign.status).toBe(404);
      const admin = await ok<{ items: { item: string; prefix: string }[] }>(await data.admin('GET', '/coding-rules'));
      expect(admin.items.find((item) => item.item === 'target')).toMatchObject({ prefix: 'MINE' });
    });
  });
});
