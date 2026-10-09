/**
 * AC-PRM-F075（DEC-369）任职资格编辑类 6 项：PATCH 任职类别分类 / 任职类别 / 指标类型 / 指标 / 标准时，writeContext 对
 * “更新用不到的引用对象”预取查看权（EmploymentCategoryClassify、TargetType、EmploymentCategory、EmploymentLevel）
 * 不影响返回。更新的请求体 schema 不含这些引用字段（categoryPatch 无 classId、targetPatch 无 typeId、standardPatch 无
 * categoryId / levelIds …），命令内也只在创建 / 导入路径 referenced()。本文件在改动前的代码上全绿，改动后原样保持全绿：
 *   - 全允许替身下，PATCH 当下撤掉冗余的查看权，转录与允许时相同，也等于改动前的黄金文件；
 *   - 真实授权器下，操作人对被引用的对象完全没有授权（noObject），PATCH 的返回等于有授权的操作人（也等于黄金文件）。
 */
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { qualificationWorld } from './AC-QL-support.js';
import { operator, type OperatorOptions, seed } from './AC-QL-perm-support.js';
import { createAuthorizerDouble } from './support/route-policy/double.js';
import { expectGolden, expectSameTranscript, step, type Step } from './support/f075-equivalence.js';

const testDb = useTestDb();
const NEW_ID = '6d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e11';
const CLASSIFY = 'obj:Qualification.EmploymentCategoryClassify:view';
const TARGET_TYPE = 'obj:Qualification.TargetType:view';
const CATEGORY = 'obj:Qualification.EmploymentCategory:view';
const LEVEL = 'obj:Qualification.EmploymentLevel:view';

type Patch = (path: string, revision: number, body: unknown, redundant: readonly string[]) => Promise<Response>;

async function scenario(w: Awaited<ReturnType<typeof qualificationWorld>>, patch: Patch): Promise<Step[]> {
  const steps: Step[] = [];
  const revision = async (path: string) => ((await w.read(path)) as { revision: number }).revision;
  const run = async (name: string, path: string, rev: number, body: unknown, redundant: readonly string[]) =>
    steps.push(await step(name, await patch(path, rev, body, redundant)));

  // 任职类别分类
  const klass = await w.categoryClass({ code: 'KA', name: '分类A' });
  const kPath = `/category-classes/${klass.id}`;
  await run('PATCH category-classes 改名', kPath, klass.revision, { name: '分类A改' }, [CLASSIFY]);
  await run('PATCH category-classes 过期', kPath, klass.revision, { name: '再改' }, [CLASSIFY]);
  await run('PATCH category-classes 停用', kPath, await revision(kPath), { enabled: false }, [CLASSIFY]);
  await run('PATCH category-classes 不存在', `/category-classes/${NEW_ID}`, 1, { name: 'x' }, [CLASSIFY]);
  await run('PATCH category-classes 非法标识', '/category-classes/not-a-uuid', 1, { name: 'x' }, [CLASSIFY]);
  await run('PATCH category-classes 非法体', kPath, await revision(kPath), { name: '' }, [CLASSIFY]);
  await run('PATCH category-classes 多余字段', kPath, await revision(kPath), { parentId: NEW_ID }, [CLASSIFY]);
  steps.push(await step('GET category-classes', await w.request('GET', '/category-classes')));

  // 任职类别（含关联岗职务的派生清空，仍走原有的岗职务查看权）
  const open = await w.categoryClass({ code: 'KB', name: '分类B' });
  const category = await w.category(open.id, { code: 'CA', name: '类别A' });
  const cPath = `/categories/${category.id}`;
  await run('PATCH categories 改名', cPath, category.revision, { name: '类别A改' }, [CLASSIFY]);
  await run('PATCH categories 过期', cPath, category.revision, { name: '再改' }, [CLASSIFY]);
  await run('PATCH categories 停用', cPath, await revision(cPath), { enabled: false }, [CLASSIFY]);
  await run('PATCH categories 不存在', `/categories/${NEW_ID}`, 1, { name: 'x' }, [CLASSIFY]);
  await run('PATCH categories 非法体', cPath, await revision(cPath), { name: '' }, [CLASSIFY]);
  await run('PATCH categories 多余字段 classId', cPath, await revision(cPath), { classId: open.id }, [CLASSIFY]);
  const sequence = await w.sequence('序列甲');
  await run(
    'PATCH categories 关联岗职务',
    cPath,
    await revision(cPath),
    { jobLinkType: 'sequence', jobLinks: [sequence] },
    [CLASSIFY],
  );
  steps.push(await step('GET categories/:id', await w.request('GET', cPath)));

  // 指标类型
  const type = await w.targetType({ code: 'TA', name: '类型A' });
  const tPath = `/target-types/${type.id}`;
  await run('PATCH target-types 改名', tPath, type.revision, { name: '类型A改' }, [TARGET_TYPE]);
  await run('PATCH target-types 过期', tPath, type.revision, { name: '再改' }, [TARGET_TYPE]);
  await run('PATCH target-types 不存在', `/target-types/${NEW_ID}`, 1, { name: 'x' }, [TARGET_TYPE]);
  await run('PATCH target-types 多余字段', tPath, await revision(tPath), { parentId: NEW_ID }, [TARGET_TYPE]);
  steps.push(await step('GET target-types', await w.request('GET', '/target-types')));

  // 指标（更新仍引用等级方案：评级指标换方案走 referenced(gradeScheme)）
  const target = await w.target(type.id, { code: 'ZA', name: '指标A', description: '说明A', evalMode: 'score' });
  const zPath = `/targets/${target.id}`;
  await run('PATCH targets 改名', zPath, target.revision, { name: '指标A改', description: '说明B' }, [TARGET_TYPE]);
  await run('PATCH targets 过期', zPath, target.revision, { name: '再改' }, [TARGET_TYPE]);
  await run('PATCH targets 评级缺方案', zPath, await revision(zPath), { evalMode: 'grade' }, [TARGET_TYPE]);
  const scheme = await w.gradeScheme([{ name: '初级', grade: 1 }], { name: '方案A' });
  await run('PATCH targets 评级方案', zPath, await revision(zPath), { evalMode: 'grade', gradeSchemeId: scheme.id }, [
    TARGET_TYPE,
  ]);
  await run('PATCH targets 方案不存在', zPath, await revision(zPath), { gradeSchemeId: NEW_ID }, [TARGET_TYPE]);
  await run('PATCH targets 不存在', `/targets/${NEW_ID}`, 1, { name: 'x' }, [TARGET_TYPE]);
  await run('PATCH targets 多余字段 typeId', zPath, await revision(zPath), { typeId: type.id }, [TARGET_TYPE]);
  steps.push(await step('GET targets/:id', await w.request('GET', zPath)));

  // 标准（更新仍引用指标）
  const level = await w.level(1, { code: 'LA', name: 'P1' });
  const scoreTarget = await w.target(type.id, { code: 'ZB', name: '指标B', description: '说明', evalMode: 'score' });
  const category2 = await w.category(open.id, { code: 'CB', name: '类别B' });
  const standard = await w.standard({
    categoryId: category2.id,
    levelIds: [level.id],
    details: [{ levelId: level.id, targetId: scoreTarget.id }],
  });
  const sPath = `/standards/${standard.id}`;
  await run('PATCH standards 改名', sPath, standard.revision, { name: '标准A改' }, [CATEGORY, LEVEL]);
  await run('PATCH standards 过期', sPath, standard.revision, { name: '再改' }, [CATEGORY, LEVEL]);
  await run(
    'PATCH standards 明细',
    sPath,
    await revision(sPath),
    { details: [{ levelId: level.id, targetId: scoreTarget.id, abilities: [{ content: '能力说明' }] }] },
    [CATEGORY, LEVEL],
  );
  await run(
    'PATCH standards 明细指标不存在',
    sPath,
    await revision(sPath),
    { details: [{ levelId: level.id, targetId: NEW_ID }] },
    [CATEGORY, LEVEL],
  );
  await run('PATCH standards 不存在', `/standards/${NEW_ID}`, 1, { name: 'x' }, [CATEGORY, LEVEL]);
  await run('PATCH standards 多余字段', sPath, await revision(sPath), { categoryId: category2.id }, [CATEGORY, LEVEL]);
  steps.push(await step('GET standards/:id', await w.request('GET', sPath)));
  return steps;
}

describe('AC-PRM-F075 任职资格编辑类：去掉引用对象预取前后返回完全一致（DEC-369）', () => {
  it('全允许替身：PATCH 当下撤掉冗余的查看权，转录与允许时相同，也等于改动前的黄金文件', async () => {
    const run = async (label: string, deny: boolean) => {
      const double = createAuthorizerDouble();
      const w = await qualificationWorld(testDb().db as Db, label, { authorize: double.authorize });
      return scenario(w, async (path, revision, body, redundant) => {
        if (deny) for (const key of redundant) double.revoke(key);
        try {
          return await w.request('PATCH', path, { ifMatch: revision, body });
        } finally {
          double.configure({});
        }
      });
    };
    const allowed = await run('f075qa', false);
    const denied = await run('f075qd', true);
    expect(allowed.length).toBeGreaterThan(35);
    expectSameTranscript(denied, allowed, '撤掉冗余查看权后返回应与允许时完全一致');
    expectGolden('qualification-all-allow', allowed);
  }, 240_000);

  const scrub = (text: string) => text.replace(/\b[A-Z][0-9a-f]{6}\b/g, '<code>');

  /** 真实授权器：被引用对象完全没有授权的操作人，与有授权的操作人 PATCH 返回相同。 */
  const real = async (label: string, options: OperatorOptions, which: 'category-target' | 'standard') => {
    const world = await seedPermissionWorld(testDb().db as Db);
    const data = await seed(world);
    const op = await operator(world, { mouId: data.parentMou, ...options });
    const steps: Step[] = [];
    const run = async (name: string, path: string, revision: number, body: unknown) =>
      steps.push(await step(`${label} ${name}`, await op.request('PATCH', path, { ifMatch: revision, body })));
    const revisionOf = async (path: string) =>
      ((await (await data.admin('GET', path)).json()) as { revision: number }).revision;
    if (which === 'category-target') {
      const cat = `/categories/${data.open.id}`;
      await run('categories 改名', cat, await revisionOf(cat), { name: '公开类改' });
      await run('categories 过期', cat, 0, { name: '再改' });
      await run('categories 范围外', `/categories/${data.foreign.id}`, 1, { name: '外类改' });
      const tgt = `/targets/${data.plainTarget}`;
      await run('targets 改名', tgt, await revisionOf(tgt), { name: '普通指标改' });
      await run('targets 过期', tgt, 0, { name: '再改' });
      await run('targets 不存在', `/targets/${NEW_ID}`, 1, { name: 'x' });
    } else {
      const std = `/standards/${data.standardId}`;
      await run('standards 改名', std, await revisionOf(std), { name: '公开标准改' });
      await run('standards 过期', std, 0, { name: '再改' });
      await run('standards 明细', std, await revisionOf(std), {
        details: [{ levelId: data.levelId, targetId: data.commonTarget }],
      });
      await run('standards 不存在', `/standards/${NEW_ID}`, 1, { name: 'x' });
    }
    return steps;
  };

  it('真实授权器：完全没有被引用对象授权（noObject）的操作人，PATCH 返回与有授权的操作人一致，也等于黄金文件', async () => {
    const cases = [
      ['category-target', ['categoryClass', 'targetType']],
      ['standard', ['category', 'level']],
    ] as const;
    for (const [which, noObject] of cases) {
      const full = await real('操作人', {}, which);
      const without = await real('操作人', { noObject: [...noObject] }, which);
      expect(full.length, which).toBeGreaterThan(3);
      expectSameTranscript(without, full, `${which}：没有被引用对象授权时返回应与有授权时一致`, scrub);
      expectGolden(`qualification-real-${which}`, full, scrub);
    }
  }, 240_000);
});
