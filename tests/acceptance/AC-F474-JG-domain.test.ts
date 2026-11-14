import { describe, expect, it } from 'vitest';
import { buildJobGraph } from '@italent/domain';
import { graphInput, record } from './support/job-graph.js';

describe('AC-F474-JG-02～04 矩阵和不规范数据', () => {
  it('降序职等、类别纵向合并、序列多级列头、同格职务稳定排序，只有一端取该端范围', () => {
    const input = graphInput();
    input.posts.push(record('p2', { sequenceId: 'child', maxLevelId: 'l', code: 'A', displayOrder: 1 }));
    const result = buildJobGraph(input);
    expect(result.empty).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.layout.rowGrades.map((r) => r.grade)).toEqual([3, 2, 1]);
    expect(result.layout.levelColumns[0]?.cells).toEqual([{ levelId: 'l', name: 'l', fromRow: 1, toRow: 2 }]);
    expect(result.layout.sequenceColumns[0]).toMatchObject({
      id: 's',
      depth: 0,
      colspan: 1,
      rowspan: 1,
      children: [{ id: 'child', depth: 1, colspan: 1, rowspan: 1 }],
    });
    expect(result.layout.postCells).toEqual([
      { sequenceId: 'child', row: 1, names: ['p2', 'p'], colorKey: 0 },
      { sequenceId: 'child', row: 2, names: ['p2', 'p'], colorKey: 0 },
    ]);
    expect(result.layout.merges).toContainEqual({ fromRow: 3, toRow: 4, fromColumn: 1, toColumn: 1 });
  });
  it('职务跨最低职级起始职等到最高职级结束职等', () => {
    const input = graphInput();
    input.levels.push(record('hi', { levelTypeId: 't', minGradeId: 'g3', maxGradeId: 'g3' }));
    input.posts[0]!.maxLevelId = 'hi';
    expect(buildJobGraph(input).layout.postCells.map((c) => c.row)).toEqual([0, 1, 2]);
  });
  it('九种原因均有编码，多原因一行，异常职级职务排除', () => {
    const input = graphInput();
    input.levelTypes.push(record('disabled', { enabled: false }));
    input.levels.push(
      record('overlap', { levelTypeId: 't', minGradeId: 'g2', maxGradeId: 'g3' }),
      record('empty', { levelTypeId: 'disabled' }),
    );
    input.posts.push(record('missing'), record('parent', { sequenceId: 's', minLevelId: 'empty' }));
    const result = buildJobGraph(input);
    const codes = result.issues.flatMap((i) => i.reasons.map((r) => r.code));
    expect(new Set(codes)).toEqual(
      new Set([
        'LEVEL_GRADE_RANGE_EMPTY',
        'LEVEL_TYPE_DISABLED',
        'LEVEL_GRADE_RANGE_OVERLAP',
        'POST_LEVEL_RANGE_EMPTY',
        'POST_SEQUENCE_EMPTY',
        'POST_SEQUENCE_HAS_CHILDREN',
        'POST_BOUND_LEVEL_OVERLAP',
        'POST_BOUND_LEVEL_TYPE_DISABLED',
        'POST_BOUND_LEVEL_GRADE_EMPTY',
      ]),
    );
    expect(result.issues.filter((i) => i.objectId === 'empty')).toHaveLength(1);
    expect(result.issues.find((i) => i.objectId === 'l')?.reasons).toContainEqual({
      code: 'LEVEL_GRADE_RANGE_OVERLAP',
      params: ['overlap'],
    });
    expect(result.layout.postCells).toEqual([]);
    expect(result.layout.levelColumns.flatMap((c) => c.cells)).toEqual([]);
    expect(result.empty).toBe(true);
  });
  it('没有合规职务即空，即使有合规职级；禁用职务和序列不会入图', () => {
    const input = graphInput();
    input.posts[0]!.enabled = false;
    expect(buildJobGraph(input)).toMatchObject({ empty: true, issues: [] });
    input.posts[0]!.enabled = true;
    input.sequences[1]!.enabled = false;
    expect(buildJobGraph(input).layout.postCells).toEqual([]);
  });
  it('十层序列表头按实际深度，输入乱序仍得到相同结果', () => {
    const input = graphInput();
    input.sequences = Array.from({ length: 10 }, (_, i) => record(`s${i}`, { parentId: i ? `s${i - 1}` : null }));
    input.posts[0]!.sequenceId = 's9';
    const expected = buildJobGraph(input);
    expect(expected.layout.headerRows).toBe(10);
    input.sequences.reverse();
    input.grades.reverse();
    expect(buildJobGraph(input)).toEqual(expected);
  });
});

describe('AC-F474-JG-02 规模与边界', () => {
  it('5000 职务可生成，5001 整体拒绝', () => {
    const input = graphInput();
    input.posts = Array.from({ length: 5000 }, (_, i) =>
      record(`p${i}`, {
        name: '职',
        code: String(i),
        sequenceId: 'child',
        minLevelId: 'l',
      }),
    );
    expect(buildJobGraph(input).layout.postCells[0]?.names).toHaveLength(5000);
    input.posts.push(record('extra'));
    expect(() => buildJobGraph(input)).toThrow('GRAPH_LIMIT_POSTS');
  });
  it('列、单元格和文本上限均整单拒绝', () => {
    const columns = graphInput();
    columns.levelTypes = Array.from({ length: 300 }, (_, i) => record(`t${i}`));
    expect(() => buildJobGraph(columns)).toThrow('GRAPH_LIMIT_COLUMNS');
    const cells = graphInput();
    cells.grades = Array.from({ length: 33334 }, (_, i) => record(`g${i}`, { grade: i }));
    expect(() => buildJobGraph(cells)).toThrow('GRAPH_LIMIT_CELLS');
    const text = graphInput();
    text.posts[0]!.name = '字'.repeat(32768);
    expect(() => buildJobGraph(text)).toThrow('GRAPH_LIMIT_TEXT');
  });
  it('保留特殊字符，空集可生成，布局超过 4MiB 拒绝', () => {
    const input = graphInput();
    input.posts[0]!.name = '=A1\u0000&_x0001_';
    expect(buildJobGraph(input).layout.postCells[0]?.names).toEqual(['=A1\u0000&_x0001_']);
    expect(buildJobGraph({ grades: [], levelTypes: [], levels: [], sequences: [], posts: [] }).empty).toBe(true);
    input.grades = Array.from({ length: 200 }, (_, i) => record(`g${i}`, { grade: i }));
    input.levels[0]!.maxGradeId = 'g199';
    input.posts[0]!.name = '字'.repeat(10000);
    expect(() => buildJobGraph(input)).toThrow('GRAPH_LIMIT_BYTES');
  });
});
