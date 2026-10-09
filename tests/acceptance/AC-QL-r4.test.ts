/**
 * R3-T02 PR-A 第 4 轮（第 3 轮审查 R3-01 / R3-02，真实授权器，“使用用户”范围）：
 * - R3-01 编码规则：首次建行同其他字典只认看全部（DEC-121 / DEC-347③），只有创建人维度的人建不了、也改不了别人
 *   建的（403）；DEC-352 起规则只放开查看，看得到真实规则；
 * - R3-02 标准 / 通道审计与标准导入任务锚在所属类别上（锚点数据保留）：类别所有者删掉标准与类别后仍查得到历史；
 *   导入成功后删掉标准仍查得到任务；导入到没有标准的类别或不存在的类别，失败任务按执行人查得到。DEC-352 起标准、
 *   发展通道的审计有审计与对象查看权即可见，不再按类别归属过滤。
 */
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { code, creatorOnly, type Data, operator, type Operator, seed } from './AC-QL-perm-support.js';
import { type CategoryView, QL_NOW, type StandardView } from './AC-QL-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Rule {
  readonly id: string | null;
  readonly item: string;
  readonly revision: number;
}

const ITEMS = ['category', 'level', 'target_type', 'target'] as const;

describe('任职资格配置第 4 轮：编码规则保存与类别锚点', () => {
  let world: PermissionWorld;
  let data: Data;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
    for (const key of ['codingRule', 'category', 'standard', 'developmentChannel'] as const) {
      await creatorOnly(world, key);
    }
  });

  const ok = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  };
  const audit = () => auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
  const audited = async (op: Operator, object: 'standard' | 'developmentChannel', objectId: string) => {
    const api = audit();
    const list = await api.dataChanges(op.as, { objectType: QUALIFICATION_OBJECTS[object].code, limit: '100' });
    return list.items.filter((item) => item.objectId === objectId).map((item) => item.action);
  };
  const importLogs = async (op: Operator) =>
    (await audit().operationLogs(op.as, { objectType: QUALIFICATION_OBJECTS.standard.code })).items.filter(
      (log) => log.operator.userId === op.userId,
    );
  /** 先有看全部（建对象用），之后撤销只剩“使用用户”范围的类别所有者。 */
  const owner = () => operator(world, { mouId: data.parentMou, seeAll: true, auditor: true });
  const created = async <T>(op: Operator, path: string, body: unknown) =>
    ok<T>(await op.request('POST', path, { ifMatch: 0, body }), 201);

  describe('R3-01 编码规则写入（DEC-347③ / DEC-121；DEC-352 只放开查看）', () => {
    it('四项：只有创建人维度的人不能建（没人建过）也不能改别人建的，都 403；改后看得到真实规则', async () => {
      const op = await operator(world, {});
      const save = async (item: string) => {
        const response = await op.request('PATCH', `/coding-rules/${item}`, { ifMatch: 0, body: { prefix: 'OWN' } });
        const { error } = (await response.json()) as { error?: { code: string; message: string } };
        return { status: response.status, code: error?.code, message: error?.message };
      };
      for (const item of ITEMS) {
        const untouched = await save(item);
        expect(untouched.status, item).toBe(403);
        const rules = await ok<{ items: Rule[] }>(await data.admin('GET', '/coding-rules'));
        const rule = rules.items.find((r) => r.item === item)!;
        await ok(
          await data.admin('PATCH', `/coding-rules/${item}`, { ifMatch: rule.revision, body: { prefix: 'ADM' } }),
        );
        const taken = await save(item);
        expect(taken.status, item).toBe(403);
        const listed = await ok<{ items: Rule[] }>(await op.request('GET', '/coding-rules'));
        expect(
          listed.items.find((r) => r.item === item),
          item,
        ).toMatchObject({ prefix: 'ADM' });
      }
      const all = await ok<{ items: Rule[] }>(await data.admin('GET', '/coding-rules'));
      expect(all.items.every((rule) => rule.id !== null)).toBe(true);
    });
  });

  describe('R3-02 类别或标准删除后，审计仍按类别归属判断（DEC-197 / DEC-198）', () => {
    it('类别所有者删掉标准、再删掉类别：标准与通道的历史审计仍查得到', async () => {
      const op = await owner();
      const klass = await created<{ id: string }>(op, '/category-classes', { code: code(), name: '分类' });
      const category = await created<CategoryView>(op, '/categories', {
        code: code(),
        name: '将删类别',
        classId: klass.id,
      });
      const other = await created<CategoryView>(op, '/categories', { code: code(), name: '目的地', classId: klass.id });
      const standard = await created<StandardView>(op, '/standards', {
        categoryId: category.id,
        name: '将删标准',
        levelIds: [data.levelId],
        details: [],
      });
      await ok(
        await op.request('PUT', `/standards/${standard.id}/channels`, {
          ifMatch: standard.revision,
          body: { channels: [{ levelId: data.levelId, targetCategoryId: other.id, targetLevelId: data.levelId }] },
        }),
      );
      await op.revokeSeeAll();
      await ok(await op.request('DELETE', `/standards/${standard.id}`, { ifMatch: standard.revision + 1 }));
      await ok(await op.request('DELETE', `/categories/${category.id}`, { ifMatch: category.revision }));

      expect((await audited(op, 'standard', standard.id)).sort()).toEqual([
        'qualification.standard.create',
        'qualification.standard.delete',
      ]);
      expect((await audited(op, 'developmentChannel', standard.id)).sort()).toEqual([
        'qualification.development-channel.create',
        'qualification.development-channel.delete',
      ]);
    });

    it('导入成功后删掉标准（类别还在）：成功的导入任务仍查得到', async () => {
      const op = await owner();
      const klass = await created<{ id: string }>(op, '/category-classes', { code: code(), name: '分类' });
      const category = await created<CategoryView>(op, '/categories', {
        code: code(),
        name: '导入类别',
        classId: klass.id,
      });
      const levelCode = code('L');
      const level = await created<{ id: string }>(op, '/levels', { code: levelCode, name: '导入级别' });
      const targetCode = code('T');
      await created(op, '/targets', { code: targetCode, name: '导入指标', typeId: data.typeId, evalMode: 'score' });
      const standard = await created<StandardView>(op, '/standards', {
        categoryId: category.id,
        name: '导入标准',
        levelIds: [level.id],
        details: [],
      });
      await op.revokeSeeAll();
      await ok(
        await op.request('POST', '/standards/import', {
          body: {
            standards: [{ categoryCode: category.code, revision: standard.revision }],
            rows: [{ categoryCode: category.code, levelCode, targetCode, content: '导入内容' }],
          },
        }),
      );
      expect((await importLogs(op)).filter((log) => log.successCount === 1)).toHaveLength(1);
      await ok(await op.request('DELETE', `/standards/${standard.id}`, { ifMatch: standard.revision + 1 }));
      expect((await importLogs(op)).filter((log) => log.successCount === 1)).toHaveLength(1);
    });

    it('导入到自己没有标准的类别、或不存在的类别：失败任务按目标类别 / 执行人查得到', async () => {
      const op = await owner();
      const klass = await created<{ id: string }>(op, '/category-classes', { code: code(), name: '分类' });
      const bare = await created<CategoryView>(op, '/categories', { code: code(), name: '无标准', classId: klass.id });
      await op.revokeSeeAll();
      for (const categoryCode of [bare.code, code('NONE')]) {
        const response = await op.request('POST', '/standards/import', {
          body: {
            standards: [{ categoryCode, revision: 1 }],
            rows: [{ categoryCode, levelCode: code(), targetCode: code(), content: '内容' }],
          },
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect((await importLogs(op)).filter((log) => log.failureCount > 0)).toHaveLength(2);
    });
  });
});
