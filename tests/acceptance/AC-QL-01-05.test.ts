/**
 * R3-T02 PR-A 任职资格配置（docs/02_业务建模/23 §3、§6 AC-QL-01～05、§11、§12；设计 §3.1；DEC-331④、DEC-334①）。
 * - AC-QL-01 从职务序列引入 3 个任职类别，并与序列建立关联；
 * - AC-QL-02 同一任职类别再建第二条标准，拒绝（QL-R8）；
 * - AC-QL-03 通用指标改指标说明：所有引用它的标准里该格能力标准同步覆盖，且不可编辑（DEC-334①：覆盖写入）；
 *   非通用改通用须确认、覆盖原内容；改回非通用保留覆盖值、恢复可编辑，原内容不恢复；
 * - AC-QL-04 等级方案新增等级明细，所有评级指标自动多一条等级描述；
 * - AC-QL-05 编辑导入某格 2 条能力标准：原有能力标准全部删除，按导入重建 2 条；任一行错整批回滚；
 * - DEC-331④ 同一类型下一个岗职务只能关联一个类别，保存时拦截（原站提示原文）；
 * - QL-R2 级别顺序号缺省为当前最大 + 1、租户内唯一；QL-R6 评分 / 评级与等级方案；QL-R10 每格 1–10 条。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  type CategoryView,
  type DetailView,
  type GradeSchemeView,
  qualificationWorld,
  type StandardView,
  type TargetView,
} from './AC-QL-support.js';

const testDb = useTestDb();

const cell = (standard: StandardView, levelId: string, targetId: string): DetailView => {
  const found = standard.details.find((d) => d.levelId === levelId && d.targetId === targetId);
  expect(found, `${levelId} × ${targetId}`).toBeTruthy();
  return found!;
};
const contents = (detail: DetailView) => detail.abilities.map((ability) => ability.content);

async function gridWorld(label: string) {
  const w = await qualificationWorld(testDb().db, label);
  const klass = await w.categoryClass();
  const type = await w.targetType();
  const p1 = await w.level(10);
  const p2 = await w.level(20);
  return { w, klass, type, p1, p2 };
}

describe('AC-QL-01 从职务序列引入任职类别', () => {
  it('引入 3 个序列生成 3 个类别，各自与序列关联；名称与编码取自序列', async () => {
    const { w, klass } = await gridWorld('ql-ac01');
    const ids = [await w.sequence('研发序列'), await w.sequence('销售序列'), await w.sequence('职能序列')];
    const response = await w.request('POST', '/categories/import', {
      ifMatch: 0,
      body: { classId: klass.id, jobLinkType: 'sequence', items: ids.map((jobObjectId) => ({ jobObjectId })) },
    });
    const body = await w.ok<{ items: CategoryView[] }>(response, 201);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((c) => c.name).sort()).toEqual(['研发序列', '职能序列', '销售序列'].sort());
    for (const [index, item] of body.items.entries()) {
      expect(item).toMatchObject({
        classId: klass.id,
        jobLinkType: 'sequence',
        ownerOrgId: w.orgId,
        publicDown: false,
      });
      expect(item.jobLinks).toEqual([{ jobObjectId: ids[index] }]);
    }
    const list = await w.read<{ items: CategoryView[] }>('/categories');
    expect(list.items).toHaveLength(3);
  });

  it('DEC-331④：同一类型下一个岗职务已被其他类别关联时保存拦截，提示原文，数据不变', async () => {
    const { w, klass } = await gridWorld('ql-dup-link');
    const sequence = await w.sequence('研发序列');
    const first = await w.category(klass.id, { name: '研发类', jobLinkType: 'sequence', jobLinks: [sequence] });
    const response = await w.request('POST', '/categories', {
      ifMatch: 0,
      body: { code: 'C_DUP', name: '研发类二', classId: klass.id, jobLinkType: 'sequence', jobLinks: [sequence] },
    });
    expect(response.status).toBe(409);
    const error = ((await response.json()) as { error: { message: string; details: { reason: string } } }).error;
    expect(error.details.reason).toBe('JOB_ALREADY_LINKED');
    expect(error.message).toMatch(/^此职务序列【.+】已有关联的任职类别【研发类】$/);
    const list = await w.read<{ items: CategoryView[] }>('/categories');
    expect(list.items.map((c) => c.id)).toEqual([first.id]);
  });
});

describe('AC-QL-02 一个任职类别只对应一条标准', () => {
  it('同一类别再建第二条标准 409，数据不变；标准的资源集合随类别', async () => {
    const { w, klass, type, p1 } = await gridWorld('ql-ac02');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const first = await w.standard({ categoryId: category.id, levelIds: [p1.id], details: [] });
    expect(first.ownerOrgId).toBe(category.ownerOrgId);
    const second = await w.request('POST', '/standards', {
      ifMatch: 0,
      body: {
        categoryId: category.id,
        name: '第二条',
        levelIds: [p1.id],
        details: [{ levelId: p1.id, targetId: target.id }],
      },
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'STANDARD_EXISTS',
    );
    const list = await w.read<{ items: StandardView[] }>('/standards');
    expect(list.items.map((s) => s.id)).toEqual([first.id]);
  });
});

describe('AC-QL-03 通用指标（DEC-334① 覆盖写入）', () => {
  it('通用指标改说明：引用它的标准全部同步覆盖，且该格能力标准不可编辑', async () => {
    const { w, klass, type, p1 } = await gridWorld('ql-ac03');
    const common = await w.target(type.id, { isCommon: true, description: '说明 A', confirmOverwrite: true });
    const standards: StandardView[] = [];
    for (const name of ['甲', '乙']) {
      const category = await w.category(klass.id, { name });
      standards.push(
        await w.standard({
          categoryId: category.id,
          levelIds: [p1.id],
          details: [{ levelId: p1.id, targetId: common.id }],
        }),
      );
    }
    for (const standard of standards) {
      expect(contents(cell(standard, p1.id, common.id))).toEqual(['说明 A']);
      expect(cell(standard, p1.id, common.id).locked).toBe(true);
    }
    // 不确认覆盖 → 409，数据不变
    const unconfirmed = await w.request('PATCH', `/targets/${common.id}`, {
      ifMatch: common.revision,
      body: { description: '说明 B' },
    });
    expect(unconfirmed.status).toBe(409);
    await w.patch<TargetView>(`/targets/${common.id}`, common.revision, {
      description: '说明 B',
      confirmOverwrite: true,
    });
    for (const standard of standards) {
      const after = await w.read<StandardView>(`/standards/${standard.id}`);
      expect(contents(cell(after, p1.id, common.id))).toEqual(['说明 B']);
    }
    // 该格不可编辑
    const locked = await w.request('PATCH', `/standards/${standards[0]!.id}`, {
      ifMatch: (await w.read<StandardView>(`/standards/${standards[0]!.id}`)).revision,
      body: { details: [{ levelId: p1.id, targetId: common.id, abilities: [{ content: '手改' }] }] },
    });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'ABILITY_LOCKED_BY_COMMON',
    );
  });

  it('非通用改通用覆盖原内容；改回非通用保留覆盖值、恢复可编辑，原内容不恢复', async () => {
    const { w, klass, type, p1 } = await gridWorld('ql-q14');
    const target = await w.target(type.id, { description: '说明 A' });
    const category = await w.category(klass.id);
    const standard = await w.standard({
      categoryId: category.id,
      levelIds: [p1.id],
      details: [{ levelId: p1.id, targetId: target.id }],
    });
    // 新建标准时非通用指标的说明带入一次（QL-R5）
    expect(contents(cell(standard, p1.id, target.id))).toEqual(['说明 A']);
    const edited = await w.patch<StandardView>(`/standards/${standard.id}`, standard.revision, {
      details: [{ levelId: p1.id, targetId: target.id, abilities: [{ content: 'B' }, { content: 'C' }] }],
    });
    expect(contents(cell(edited, p1.id, target.id))).toEqual(['B', 'C']);

    const toCommon = await w.request('PATCH', `/targets/${target.id}`, {
      ifMatch: target.revision,
      body: { isCommon: true },
    });
    expect(toCommon.status).toBe(409);
    expect(((await toCommon.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'COMMON_OVERWRITE_CONFIRM',
    );
    const common = await w.patch<TargetView>(`/targets/${target.id}`, target.revision, {
      isCommon: true,
      confirmOverwrite: true,
    });
    const overwritten = await w.read<StandardView>(`/standards/${standard.id}`);
    expect(contents(cell(overwritten, p1.id, target.id))).toEqual(['说明 A']);
    expect(cell(overwritten, p1.id, target.id).locked).toBe(true);

    await w.patch<TargetView>(`/targets/${target.id}`, common.revision, { isCommon: false });
    const reverted = await w.read<StandardView>(`/standards/${standard.id}`);
    expect(contents(cell(reverted, p1.id, target.id))).toEqual(['说明 A']);
    expect(cell(reverted, p1.id, target.id).locked).toBe(false);
    const again = await w.patch<StandardView>(`/standards/${standard.id}`, reverted.revision, {
      details: [{ levelId: p1.id, targetId: target.id, abilities: [{ content: 'D' }] }],
    });
    expect(contents(cell(again, p1.id, target.id))).toEqual(['D']);
  });
});

describe('AC-QL-04 等级方案新增明细 → 评级指标多一条等级描述', () => {
  it('新增明细后每个评级指标都多一条；手改过的描述保留，未改的随明细变化', async () => {
    const { w, type } = await gridWorld('ql-ac04');
    const scheme = await w.gradeScheme([
      { name: '初级', grade: 1, description: '能完成' },
      { name: '中级', grade: 2, description: '能独立完成' },
    ]);
    const a = await w.target(type.id, { evalMode: 'grade', gradeSchemeId: scheme.id });
    const b = await w.target(type.id, { evalMode: 'grade', gradeSchemeId: scheme.id });
    type Descriptions = { items: { gradeDetailId: string; description: string | null; modified: boolean }[] };
    const before = await w.read<Descriptions>(`/targets/${a.id}/grade-descriptions`);
    expect(before.items).toHaveLength(2);
    const first = scheme.details[0]!;
    await w
      .request('PUT', `/targets/${a.id}/grade-descriptions/${first.id}`, {
        ifMatch: a.revision,
        body: { description: '手改' },
      })
      .then((r) => w.ok(r));

    const updated = await w.patch<GradeSchemeView>(`/grade-schemes/${scheme.id}`, scheme.revision, {
      details: [
        { id: first.id, name: '初级', grade: 1, description: '能完成（改）' },
        { id: scheme.details[1]!.id, name: '中级', grade: 2, description: '能独立完成' },
        { name: '高级', grade: 3, description: '能指导他人' },
      ],
    });
    expect(updated.details).toHaveLength(3);
    for (const target of [a, b]) {
      const after = await w.read<Descriptions>(`/targets/${target.id}/grade-descriptions`);
      expect(after.items).toHaveLength(3);
      expect(after.items.at(-1)).toMatchObject({ description: '能指导他人', modified: false });
    }
    const aAfter = await w.read<Descriptions>(`/targets/${a.id}/grade-descriptions`);
    expect(aAfter.items[0]).toMatchObject({ description: '手改', modified: true });
    const bAfter = await w.read<Descriptions>(`/targets/${b.id}/grade-descriptions`);
    expect(bAfter.items[0]).toMatchObject({ description: '能完成（改）', modified: false });
  });

  it('QL-R6：评分指标不能选等级方案，评级指标必须选启用的等级方案', async () => {
    const { w, type } = await gridWorld('ql-r6');
    const scheme = await w.gradeScheme([{ name: '初级', grade: 1 }]);
    for (const body of [{ evalMode: 'score', gradeSchemeId: scheme.id }, { evalMode: 'grade' }]) {
      const response = await w.request('POST', '/targets', {
        ifMatch: 0,
        body: { code: `Z${Math.random().toString(36).slice(2, 8)}`, name: '指标', typeId: type.id, ...body },
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('AC-QL-05 编辑导入标准明细', () => {
  it('导入某格 2 条能力标准：原有全部删除并重建 2 条；任一行编码不存在则整批回滚，逐行回执', async () => {
    const { w, klass, type, p1, p2 } = await gridWorld('ql-ac05');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const standard = await w.standard({
      categoryId: category.id,
      levelIds: [p1.id, p2.id],
      details: [
        {
          levelId: p1.id,
          targetId: target.id,
          abilities: [{ content: '旧1' }, { content: '旧2' }, { content: '旧3' }],
        },
      ],
    });
    const p1Code = (await w.read<{ code: string }>(`/levels/${p1.id}`)).code;
    const p2Code = (await w.read<{ code: string }>(`/levels/${p2.id}`)).code;
    const row = (levelCode: string, content: string, targetCode = target.code) => ({
      categoryCode: category.code,
      levelCode,
      targetCode,
      content,
    });
    // 逐标准带预期 revision（DEC-067，第 2 轮 P2-06），不再用 If-Match
    const standards = [{ categoryCode: category.code, revision: standard.revision }];
    const bad = await w.request('POST', '/standards/import', {
      body: { standards, rows: [row(p1Code, '新1'), row(p2Code, '新X', 'NOPE')] },
    });
    expect(bad.status).toBe(400);
    const receipts = ((await bad.json()) as { error: { details: { receipts: { row: number; reason: string }[] } } })
      .error.details.receipts;
    expect(receipts).toEqual([{ row: 2, reason: 'TARGET_NOT_FOUND' }]);
    expect(contents(cell(await w.read<StandardView>(`/standards/${standard.id}`), p1.id, target.id))).toEqual([
      '旧1',
      '旧2',
      '旧3',
    ]);

    const good = await w.request('POST', '/standards/import', {
      body: { standards, rows: [row(p1Code, '新1'), row(p1Code, '新2'), row(p2Code, '新3')] },
    });
    await w.ok(good);
    const after = await w.read<StandardView>(`/standards/${standard.id}`);
    expect(contents(cell(after, p1.id, target.id))).toEqual(['新1', '新2']);
    expect(contents(cell(after, p2.id, target.id))).toEqual(['新3']);
  });

  it('QL-R10：每格 1–10 条能力标准；超过 10 条 400', async () => {
    const { w, klass, type, p1 } = await gridWorld('ql-r10');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const response = await w.request('POST', '/standards', {
      ifMatch: 0,
      body: {
        categoryId: category.id,
        name: '标准',
        levelIds: [p1.id],
        details: [
          {
            levelId: p1.id,
            targetId: target.id,
            abilities: Array.from({ length: 11 }, (_, i) => ({ content: `${i}` })),
          },
        ],
      },
    });
    expect(response.status).toBe(400);
  });
});

describe('QL-R2 级别顺序号', () => {
  it('新建缺省为当前最大顺序号 + 1；顺序号重复 409', async () => {
    const { w, p2 } = await gridWorld('ql-r2');
    const next = await w.created<{ displayOrder: number }>('/levels', { code: 'LX', name: 'P3' });
    expect(next.displayOrder).toBe(p2.displayOrder + 1);
    const dup = await w.request('POST', '/levels', { ifMatch: 0, body: { code: 'LY', name: 'P4', displayOrder: 20 } });
    expect(dup.status).toBe(409);
  });
});
