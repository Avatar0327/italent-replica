/**
 * R3-T02 PR-A 第 3 轮（第 2 轮审查 R2-02 / 04 / 05，真实授权器，“使用用户”范围）：
 * - R2-02 编码规则（DEC-347③ 看全部 ∪ 创建人）：查看人看不到的规则照样显示缺省占位，不透露是否已被别人建过；
 * - R2-04 标准 / 发展通道的审计与业务同锚在所属类别的 owner 上：在别人的类别下建的标准 / 通道，撤销看全部后
 *   业务 404，审计也查不到；自己类别下的照常查得到；
 * - R2-05 新增审计带创建人归属：编码规则首次保存记为新增；删除指标 / 等级方案连带的描述删除日志随所属指标的
 *   创建人归属，“使用用户”范围的审计员查得到自己的。
 */
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { code, creatorOnly, type Data, operator, type Operator, seed } from './AC-QL-perm-support.js';
import { type CategoryView, type GradeSchemeView, QL_NOW, type StandardView } from './AC-QL-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Rule {
  readonly id: string | null;
  readonly item: string;
  readonly enabled: boolean;
  readonly prefix: string;
  readonly nextSeq: number;
  readonly revision: number;
}

describe('任职资格配置第 3 轮：创建人范围', () => {
  let world: PermissionWorld;
  let data: Data;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
    for (const key of ['codingRule', 'category', 'standard', 'developmentChannel', 'target'] as const) {
      await creatorOnly(world, key);
    }
    await creatorOnly(world, 'targetGradeDescription');
    await creatorOnly(world, 'gradeScheme');
  });

  const ok = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  };
  const audit = () => auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
  /** 某对象的审计（列表 + 详情）：条数与动作。 */
  const audited = async (op: Operator, object: keyof typeof QUALIFICATION_OBJECTS, objectId: string) => {
    const api = audit();
    const list = await api.dataChanges(op.as, { objectType: QUALIFICATION_OBJECTS[object].code, limit: '100' });
    const mine = list.items.filter((item) => item.objectId === objectId);
    for (const item of mine) await api.dataChange(op.as, item.id);
    return mine.map((item) => item.action);
  };
  const rules = async (op: Operator) => (await ok<{ items: Rule[] }>(await op.request('GET', '/coding-rules'))).items;
  /** 先有看全部、能在上级部建对象的操作人；用完撤销看全部，只剩“使用用户”范围。 */
  const creator = () => operator(world, { mouId: data.parentMou, seeAll: true, auditor: true });

  describe('R2-02 编码规则缺省占位不透露别人是否已建（DEC-347③）', () => {
    it('别人建过的项：照样显示缺省占位，与没人建过的项无从区分', async () => {
      const all = await rules(await operator(world, { seeAll: true }));
      const category = all.find((rule) => rule.item === 'category')!;
      await ok(
        await data.admin('PATCH', '/coding-rules/category', {
          ifMatch: category.revision,
          body: { enabled: true, prefix: 'ADMINX' },
        }),
      );
      const op = await operator(world, {});
      const listed = await rules(op);
      expect(listed.map((rule) => rule.item)).toEqual(['category', 'level', 'target_type', 'target']);
      const { item: _c, ...taken } = listed.find((rule) => rule.item === 'category')!;
      const { item: _l, ...blank } = listed.find((rule) => rule.item === 'level')!;
      expect(taken).toEqual(blank);
      expect(JSON.stringify(listed)).not.toContain('ADMINX');
    });
  });

  describe('R2-04 标准 / 通道审计锚在所属类别的 owner 上（DEC-197，设计 §5.1 / §8）', () => {
    it('别人类别下自己建的标准与通道：撤销看全部后业务 404、审计查不到；自己类别下的照常可查', async () => {
      const admin = await data.adminIn(data.parent);
      const klass = await admin<{ id: string }>('/category-classes', { code: code(), name: '他人分类' });
      const foreignCategory = await admin<CategoryView>('/categories', {
        code: code(),
        name: '他人类别',
        classId: klass.id,
      });
      const other = await admin<CategoryView>('/categories', { code: code(), name: '通道目的地', classId: klass.id });
      const op = await creator();
      const ownClass = await ok<{ id: string }>(
        await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: code(), name: '自己的分类' } }),
        201,
      );
      const ownCategory = await ok<CategoryView>(
        await op.request('POST', '/categories', {
          ifMatch: 0,
          body: { code: code(), name: '自己的类别', classId: ownClass.id },
        }),
        201,
      );
      const standardIn = async (categoryId: string) => {
        const standard = await ok<StandardView>(
          await op.request('POST', '/standards', {
            ifMatch: 0,
            body: { categoryId, name: '标准', levelIds: [data.levelId], details: [] },
          }),
          201,
        );
        await ok(
          await op.request('PUT', `/standards/${standard.id}/channels`, {
            ifMatch: standard.revision,
            body: { channels: [{ levelId: data.levelId, targetCategoryId: other.id, targetLevelId: data.levelId }] },
          }),
        );
        return standard;
      };
      const foreign = await standardIn(foreignCategory.id);
      const own = await standardIn(ownCategory.id);
      await op.revokeSeeAll();

      expect((await op.request('GET', `/standards/${foreign.id}`)).status).toBe(404);
      expect((await op.request('GET', `/standards/${foreign.id}/channels`)).status).toBe(404);
      expect(await audited(op, 'standard', foreign.id)).toEqual([]);
      expect(await audited(op, 'developmentChannel', foreign.id)).toEqual([]);

      expect((await op.request('GET', `/standards/${own.id}`)).status).toBe(200);
      expect(await audited(op, 'standard', own.id)).toContain('qualification.standard.create');
      expect(await audited(op, 'developmentChannel', own.id)).toContain('qualification.development-channel.create');
    });
  });

  describe('R2-05 新增审计带创建人归属（DEC-198）', () => {
    it('编码规则：首次保存记为新增，创建人范围的审计员查得到自己规则的全部日志', async () => {
      const op = await operator(world, { auditor: true });
      const blank = (await rules(op)).find((rule) => rule.item === 'target')!;
      const saved = await ok<Rule>(
        await op.request('PATCH', '/coding-rules/target', { ifMatch: blank.revision, body: { prefix: 'MINE' } }),
      );
      await ok(await data.admin('PATCH', '/coding-rules/target', { ifMatch: saved.revision, body: { nextSeq: 5 } }));
      const actions = await audited(op, 'codingRule', saved.id!);
      expect(actions.sort()).toEqual(['qualification.coding-rule.create', 'qualification.coding-rule.update']);
    });

    it('删除指标 / 删除等级方案连带的描述删除日志：指标创建人查得到', async () => {
      const op = await creator();
      const scheme = async () =>
        ok<GradeSchemeView>(
          await op.request('POST', '/grade-schemes', {
            ifMatch: 0,
            body: { name: `方案${code()}`, details: [{ name: '初级', grade: 1, description: '明细' }] },
          }),
          201,
        );
      const graded = async (schemeView: GradeSchemeView) => {
        const target = await ok<{ id: string; revision: number }>(
          await op.request('POST', '/targets', {
            ifMatch: 0,
            body: { code: code(), name: '评级', typeId: data.typeId, evalMode: 'grade', gradeSchemeId: schemeView.id },
          }),
          201,
        );
        await ok(
          await op.request('PUT', `/targets/${target.id}/grade-descriptions/${schemeView.details[0]!.id}`, {
            ifMatch: target.revision,
            body: { description: '手改' },
          }),
        );
        return { id: target.id, revision: target.revision + 1 };
      };
      const first = await graded(await scheme());
      const oldScheme = await scheme();
      const second = await graded(oldScheme);
      const newScheme = await scheme();
      await op.revokeSeeAll();

      await ok(await op.request('DELETE', `/targets/${first.id}`, { ifMatch: first.revision }));
      await ok(
        await op.request('PATCH', `/targets/${second.id}`, {
          ifMatch: second.revision,
          body: { gradeSchemeId: newScheme.id },
        }),
      );
      await ok(await op.request('DELETE', `/grade-schemes/${oldScheme.id}`, { ifMatch: oldScheme.revision }));
      const deleted = 'qualification.target-grade-description.delete';
      expect(await audited(op, 'targetGradeDescription', first.id)).toContain(deleted);
      expect(await audited(op, 'targetGradeDescription', second.id)).toContain(deleted);
    });
  });
});
