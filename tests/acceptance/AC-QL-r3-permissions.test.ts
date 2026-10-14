/**
 * R3-T02 PR-A 第 3 轮（第 2 轮审查 R2-01 / 03 / 06 / 07，真实授权器，管理单元范围）：
 * - DEC-349 横向通道的保存提示（DEC-347② / DEC-348①）不按权限裁剪：提示用于敦促业务方与 HR 建设标准，有通道
 *   编辑权的人首次与重放都照常拿到（R2-01 按用户决定关闭）；
 * - R2-03 发展通道审计里的目标类别 / 级别按查看人当前对类别 / 级别的读取权裁剪，与通道 GET 一致（DEC-197）；
 * - R2-06 删除等级方案连带的遗留手改描述，所属指标须在操作人当前的写范围内，否则整体拒绝；
 * - R2-07 引入 / 导入失败的任务日志按实际操作的管理单元 / 目标锚点登记，操作人走授权查询能查到（DEC-199）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { code, creatorOnly, type Data, operator, type Operator, seed } from './AC-QL-perm-support.js';
import { type CategoryView, type GradeSchemeView, QL_NOW, type StandardView } from './AC-QL-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Warning {
  readonly index: number;
  readonly reason: string;
}

describe('任职资格配置第 3 轮：提示、审计与级联的范围', () => {
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
  const childOp = (extra: Parameters<typeof operator>[1] = {}) => operator(world, { mouId: data.childMou, ...extra });
  /** 下级部的一套：源类别（有标准，含级别 P1）、目的地类别、目的地级别 P2。 */
  const channelSet = async () => {
    const create = await data.adminIn(data.child);
    const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '通道分类' });
    const source = await create<CategoryView>('/categories', { code: code(), name: '源类别', classId: klass.id });
    const destination = await create<CategoryView>('/categories', {
      code: code(),
      name: '目的地类别',
      classId: klass.id,
    });
    const p1 = await create<{ id: string }>('/levels', { code: code(), name: 'P1' });
    const p2 = await create<{ id: string }>('/levels', { code: code(), name: 'P2' });
    const standard = await create<StandardView>('/standards', {
      categoryId: source.id,
      name: '源标准',
      levelIds: [p1.id],
      details: [],
    });
    return { create, source, destination, p1, p2, standard };
  };
  const warningsOf = async (response: Response) =>
    ((await ok<{ warnings?: Warning[] }>(response)).warnings ?? []) as Warning[];

  describe('DEC-349 通道提示不按权限裁剪（用于敦促建设标准；R2-01 按用户决定关闭）', () => {
    it('没有标准查看权的通道编辑人：目的地没有标准、目标级别不在标准里都照常提示', async () => {
      const set = await channelSet();
      const op = await childOp({ noObject: ['standard'] });
      expect((await op.request('GET', `/standards/${set.standard.id}`)).status).toBe(403);
      const path = `/standards/${set.standard.id}/channels`;
      const body = {
        channels: [{ levelId: set.p1.id, targetCategoryId: set.destination.id, targetLevelId: set.p1.id }],
      };
      expect(await warningsOf(await op.request('PUT', path, { ifMatch: set.standard.revision, body }))).toEqual([
        { index: 0, reason: 'TARGET_STANDARD_MISSING' },
      ]);
      await set.create('/standards', {
        categoryId: set.destination.id,
        name: '目的地标准',
        levelIds: [set.p2.id],
        details: [],
      });
      expect(await warningsOf(await op.request('PUT', path, { ifMatch: set.standard.revision + 1, body }))).toEqual([
        { index: 0, reason: 'TARGET_LEVEL_NOT_IN_STANDARD' },
      ]);
    });

    it('看不到标准的 levelIds：首次与同键重放都照常提示，提示只有序号与原因', async () => {
      const set = await channelSet();
      await set.create('/standards', {
        categoryId: set.destination.id,
        name: '目的地标准',
        levelIds: [set.p2.id],
        details: [],
      });
      const op: Operator = await childOp({ hidden: { standard: ['levelIds'] } });
      const path = `/standards/${set.standard.id}/channels`;
      const body = {
        channels: [{ levelId: set.p1.id, targetCategoryId: set.destination.id, targetLevelId: set.p1.id }],
      };
      const idempotencyKey = randomUUID();
      const expected = [{ index: 0, reason: 'TARGET_LEVEL_NOT_IN_STANDARD' }];
      const first = await op.request('PUT', path, { ifMatch: set.standard.revision, body, idempotencyKey });
      expect(await warningsOf(first)).toEqual(expected);
      const replay = await op.request('PUT', path, { ifMatch: set.standard.revision, body, idempotencyKey });
      expect(await warningsOf(replay)).toEqual(expected);
    });
  });

  describe('R2-03 通道审计的目标类别 / 级别按当前读取权裁剪（DEC-197）', () => {
    it('通道新增、移除与删除标准级联的日志：看不到类别 / 级别的审计员看不到目标 ID；有权的看得到', async () => {
      const set = await channelSet();
      const path = `/standards/${set.standard.id}/channels`;
      const channel = { levelId: set.p1.id, targetCategoryId: set.destination.id, targetLevelId: set.p2.id };
      await ok(await data.admin('PUT', path, { ifMatch: set.standard.revision, body: { channels: [channel] } }));
      await ok(await data.admin('PUT', path, { ifMatch: set.standard.revision + 1, body: { channels: [] } }));
      await ok(await data.admin('PUT', path, { ifMatch: set.standard.revision + 2, body: { channels: [channel] } }));
      await ok(await data.admin('DELETE', `/standards/${set.standard.id}`, { ifMatch: set.standard.revision + 3 }));

      const type = QUALIFICATION_OBJECTS.developmentChannel.code;
      const audit = auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
      const seen = async (op: Operator) => {
        const list = await audit.dataChanges(op.as, { objectType: type, limit: '100' });
        const mine = list.items.filter((item) => item.objectId === set.standard.id);
        const details = [];
        for (const item of mine) details.push(await audit.dataChange(op.as, item.id));
        return { count: mine.length, text: JSON.stringify([mine, details]) };
      };
      const blind = await childOp({ auditor: true, noObject: ['category', 'level'] });
      const hidden = await seen(blind);
      expect(hidden.count).toBe(4);
      expect(hidden.text).not.toContain(set.destination.id);
      expect(hidden.text).not.toContain(set.p2.id);
      const sighted = await seen(await childOp({ auditor: true }));
      expect(sighted.count).toBe(4);
      expect(sighted.text).toContain(set.destination.id);
      expect(sighted.text).toContain(set.p2.id);
    });
  });

  describe('R2-06 删除等级方案：遗留描述所属指标须在操作人的写范围内（DEC-338 自检规则）', () => {
    it('范围外指标在旧方案上留有手改描述：整体拒绝，描述还在；管理员删除照常', async () => {
      // 等级方案是字典（新建要看全部，之后按创建人，DEC-121）：操作人先在看全部下建方案，撤销后按创建人维度管
      // 自己的方案，指标仍按管理单元（下级部）
      await creatorOnly(world, 'gradeScheme');
      const op = await childOp({ seeAll: true });
      const scheme = await ok<GradeSchemeView>(
        await op.request('POST', '/grade-schemes', {
          ifMatch: 0,
          body: { name: `旧方案${code()}`, details: [{ name: '初级', grade: 1, description: '旧明细' }] },
        }),
        201,
      );
      const replacement = await ok<{ id: string }>(
        await data.admin('POST', '/grade-schemes', {
          ifMatch: 0,
          body: { name: `新方案${code()}`, details: [{ name: '初级', grade: 1 }] },
        }),
        201,
      );
      const create = await data.adminIn(data.outside);
      const target = await create<{ id: string; revision: number }>('/targets', {
        code: code(),
        name: '范围外评级',
        typeId: data.typeId,
        evalMode: 'grade',
        gradeSchemeId: scheme.id,
      });
      await ok(
        await data.admin('PUT', `/targets/${target.id}/grade-descriptions/${scheme.details[0]!.id}`, {
          ifMatch: target.revision,
          body: { description: '范围外手改' },
        }),
      );
      await ok(
        await data.admin('PATCH', `/targets/${target.id}`, {
          ifMatch: target.revision + 1,
          body: { gradeSchemeId: replacement.id },
        }),
      );
      await op.revokeSeeAll();
      // DEC-352：指标只放开查看，范围外的指标看得到；但不在操作人的写范围内
      expect((await op.request('GET', `/targets/${target.id}`)).status).toBe(200);
      const leftovers = () =>
        withTenant(testDb().db, world.tenant.id, async (tx) => {
          const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ql_target_grade_descriptions
            WHERE tenant_id = ${world.tenant.id}::uuid AND target_id = ${target.id}::uuid`);
          return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { n: number }[])[0]!.n;
        });
      const rejected = await op.request('DELETE', `/grade-schemes/${scheme.id}`, { ifMatch: scheme.revision });
      expect(rejected.status, await rejected.clone().text()).toBe(403);
      expect(await leftovers()).toBe(1);
      await ok(await data.admin('DELETE', `/grade-schemes/${scheme.id}`, { ifMatch: scheme.revision }));
      expect(await leftovers()).toBe(0);
    });
  });

  describe('R2-07 引入 / 导入失败的任务日志按实际管理单元 / 目标锚点登记（DEC-199）', () => {
    it('单单元自动填的类别 / 级别引入、没有所属单元字段的标准导入：失败后操作人经授权查询查得到', async () => {
      const set = await channelSet();
      const op = await childOp({ auditor: true, sequenceHidden: [] });
      const category = await op.request('POST', '/categories/import', {
        ifMatch: 0,
        body: { classId: randomUUID(), jobLinkType: 'sequence', items: [{ jobObjectId: data.sequences[0] }] },
      });
      expect(category.status).toBe(404);
      const level = await op.request('POST', '/levels/import', {
        ifMatch: 0,
        body: { jobLinkType: 'level', items: [{ jobObjectId: randomUUID() }] },
      });
      expect(level.status).toBe(404);
      const standard = await op.request('POST', '/standards/import', {
        body: {
          standards: [{ categoryCode: set.source.code, revision: set.standard.revision + 99 }],
          rows: [{ categoryCode: set.source.code, levelCode: code(), targetCode: code(), content: '内容' }],
        },
      });
      expect(standard.status).toBeGreaterThanOrEqual(400);
      const audit = auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
      const failed = async (object: 'category' | 'level' | 'standard') => {
        const page = await audit.operationLogs(op.as, { objectType: QUALIFICATION_OBJECTS[object].code });
        return page.items.filter((log) => log.operator.userId === op.userId && log.failureCount > 0);
      };
      expect(await failed('category')).toHaveLength(1);
      expect(await failed('level')).toHaveLength(1);
      expect(await failed('standard')).toHaveLength(1);
    });

    it('标准导入写了范围外或不存在的类别编码：失败日志都归到操作人自己的单元，不能借日志可见与否试探存在性', async () => {
      const op = await childOp({ auditor: true });
      const audit = auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
      const visibleFailures = async () =>
        (await audit.operationLogs(op.as, { objectType: QUALIFICATION_OBJECTS.standard.code })).items.filter(
          (log) => log.operator.userId === op.userId && log.failureCount > 0,
        ).length;
      for (const categoryCode of [data.foreign.code, code('NONE')]) {
        const response = await op.request('POST', '/standards/import', {
          body: {
            standards: [{ categoryCode, revision: 1 }],
            rows: [{ categoryCode, levelCode: code(), targetCode: code(), content: '内容' }],
          },
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect(await visibleFailures()).toBe(2);
    });
  });
});
