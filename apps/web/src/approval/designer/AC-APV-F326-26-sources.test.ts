/** F-326 F3（AC-APV-F326-26）：设计器三类来源取消灰显；规则与领域校验同源，候选按后端真实形状，合成 ID。 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_TYPES, type ApproverSource } from '@italent/domain';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { buildDraft, nodeField } from './model.js';
import type { ApiClient } from '../../foundation/client.js';
import {
  acceptCandidates,
  candidateParams,
  matrixOptions,
  multipleHint,
  readMatrixCandidates,
  type CandidateQuery,
} from './source-candidates.js';
import { matrixReference, referenceOf, sourceInputError, sourceOptions } from './sources.js';

const VARIABLE = 'b3260000-0000-4000-8000-000000000001';
const MATRIX = 'b3260000-0000-4000-8000-000000000002';
const COLUMN = 'b3260000-0000-4000-8000-000000000003';
const THREE = ['public_variable', 'application_variable', 'matrix'] as const;
// 手写期望：矩阵只给有任职申请业务日的单主体适配器，另加个人信息变更（设计 §3.4、DEC-902）
const MATRIX_ADAPTERS = ['employment', 'part_time', 'exit_handover', 'personnel_change'];
const node = () => flowFixture().latestVersion.nodes[0]!;
const error = (source: ApproverSource, code = 'transfer') => sourceInputError(source, node(), code);

describe('AC-APV-F326-26 设计器三类来源', () => {
  it('01 调动流程：公共变量 / 应用变量 / 审批矩阵可选，任何审批类型都不再出现“暂不支持”', () => {
    for (const type of THREE)
      expect(
        sourceOptions(node(), 'transfer').find((o) => o.value === type),
        type,
      ).toMatchObject({
        disabled: false,
        status: 'enabled',
        label: { public_variable: '公共变量', application_variable: '应用变量', matrix: '审批矩阵' }[type],
      });
    for (const code of Object.keys(APPROVAL_TYPES))
      for (const option of sourceOptions(node(), code))
        expect(option.label, `${code}/${option.value}`).not.toContain('暂不支持');
  });
  it('02 矩阵只在有任职申请业务日的类型可选，其余可见但禁用并注明原因；两类变量除组织调整外都可选', () => {
    for (const [code, type] of Object.entries(APPROVAL_TYPES)) {
      const options = sourceOptions(node(), code);
      const matrix = options.find((o) => o.value === 'matrix')!;
      if (MATRIX_ADAPTERS.includes(type.adapter))
        expect(matrix, code).toMatchObject({ disabled: false, label: '审批矩阵' });
      else expect(matrix, code).toMatchObject({ disabled: true, label: '审批矩阵 · 该审批类型不可选' });
      // 组织调整只收白名单命名取值（R2-T08 §4.2、DEC-697），变量与其余来源一样可见但禁用
      for (const variable of ['public_variable', 'application_variable'])
        expect(
          options.find((o) => o.value === variable),
          `${code}/${variable}`,
        ).toMatchObject(
          type.adapter === 'org_adjustment'
            ? { disabled: true, status: 'restricted' }
            : { disabled: false, status: 'enabled' },
        );
    }
    expect(error({ type: 'matrix', value: `${MATRIX}:${COLUMN}` }, 'offer')).toBe('审批矩阵 · 该审批类型不可选');
    expect(error({ type: 'matrix', value: `${MATRIX}:${COLUMN}` }, 'personnel_change')).toBeUndefined();
  });
  it('03 取值格式与领域同源：变量是 UUID，矩阵是“矩阵:角色列”两段 UUID，其余拒绝', () => {
    expect(error({ type: 'public_variable', value: VARIABLE })).toBeUndefined();
    expect(error({ type: 'application_variable', value: VARIABLE })).toBeUndefined();
    expect(error({ type: 'matrix', value: `${MATRIX}:${COLUMN}` })).toBeUndefined();
    for (const bad of [
      { type: 'public_variable', value: '' },
      { type: 'application_variable', value: `${VARIABLE}:descendants` },
      { type: 'matrix', value: MATRIX },
      { type: 'matrix', value: `${MATRIX}:${COLUMN}:${COLUMN}` },
      { type: 'matrix', value: `${MATRIX}:not-a-column` },
    ] as ApproverSource[])
      expect(error(bad), `${bad.type}/${bad.value}`).toBe('请选择有效的审批人来源类型和值');
  });
  it('04 保存草稿：三类合法值进入载荷，会签节点可混用', () => {
    const flow = flowFixture();
    const field = nodeField('manager', 'approver');
    for (const source of [
      { type: 'public_variable', value: VARIABLE },
      { type: 'application_variable', value: VARIABLE },
      { type: 'matrix', value: `${MATRIX}:${COLUMN}` },
    ] as ApproverSource[])
      expect(buildDraft(flow.latestVersion, { [field]: source }, 'transfer').nodes[0], source.type).toMatchObject({
        approver: source,
      });
    const countersign = { ...node(), kind: 'countersign' as const } as ReturnType<typeof node>;
    const mixed: ApproverSource[] = [
      { type: 'public_variable', value: VARIABLE },
      { type: 'matrix', value: `${MATRIX}:${COLUMN}` },
    ];
    expect(sourceInputError(mixed, countersign, 'transfer')).toBeUndefined();
  });
  it('05 候选按后端真实形状：变量与角色列带 multiple，矩阵头无该字段；multiple 类型错拒绝', () => {
    // 与 designer-sources.ts listDesignerSources 同形：multiple 为 null 时整键省略
    const body = {
      items: [
        { id: MATRIX, name: '合成矩阵', enabled: true, parentId: null },
        { id: `${MATRIX}:${COLUMN}`, name: '角色', enabled: true, parentId: MATRIX, multiple: true },
        { id: VARIABLE, name: '合成变量（Global.B.V1）', enabled: false, parentId: null, multiple: false },
      ],
      page: 1,
      pageSize: 200,
      hasMore: false,
    };
    expect(acceptCandidates(body)).toEqual({ items: body.items, hasMore: false });
    const bad = {
      ...body,
      items: [{ id: VARIABLE, name: '合成变量', enabled: true, parentId: null, multiple: 'yes' }],
    };
    expect(() => acceptCandidates(bad)).toThrow();
  });
  it('06 候选查询：应用变量带审批类型（搜索与回查），公共变量 / 矩阵不带；矩阵回查收“矩阵”与“矩阵:角色列”', () => {
    const query = (over: Partial<CandidateQuery> & Record<string, unknown>) =>
      Object.fromEntries(
        candidateParams({ type: 'application_variable', asOf: '2026-11-14', ...over } as CandidateQuery),
      );
    expect(query({ approvalType: 'transfer', keyword: '合成' })).toEqual({
      type: 'application_variable',
      asOf: '2026-11-14',
      approvalType: 'transfer',
      pageSize: '50',
      keyword: '合成',
    });
    expect(query({ approvalType: 'transfer', ids: [VARIABLE] })).toEqual({
      type: 'application_variable',
      asOf: '2026-11-14',
      approvalType: 'transfer',
      ids: VARIABLE,
      includeInactive: 'true',
    });
    expect(query({ type: 'public_variable', approvalType: 'transfer' })).not.toHaveProperty('approvalType');
    expect(query({ type: 'matrix', approvalType: 'transfer', ids: [MATRIX, `${MATRIX}:${COLUMN}`] })).toEqual({
      type: 'matrix',
      asOf: '2026-11-14',
      ids: `${MATRIX},${MATRIX}:${COLUMN}`,
      includeInactive: 'true',
    });
  });
  it('07 矩阵两级：按 parentId 分组；值拆成矩阵与角色列；变量值即对象 ID', () => {
    const OTHER = 'b3260000-0000-4000-8000-000000000004';
    const items = [
      { id: OTHER, name: '甲矩阵', enabled: true, parentId: null },
      { id: `${MATRIX}:${COLUMN}`, name: '角色', enabled: true, parentId: MATRIX, multiple: false },
      { id: MATRIX, name: '乙矩阵', enabled: true, parentId: null },
    ];
    expect(matrixOptions(items)).toEqual([
      { head: items[0], columns: [] },
      { head: items[2], columns: [items[1]] },
    ]);
    expect(matrixReference({ type: 'matrix', value: `${MATRIX}:${COLUMN}` })).toEqual({
      matrixId: MATRIX,
      columnKey: `${MATRIX}:${COLUMN}`,
    });
    expect(matrixReference({ type: 'matrix', value: MATRIX })).toBeNull();
    expect(referenceOf({ type: 'public_variable', value: VARIABLE })).toEqual({ id: VARIABLE, mode: 'self' });
    expect(referenceOf({ type: 'application_variable', value: 'x' })).toBeNull();
  });
  it('08 多人提示只在单人节点主审批人、且候选 multiple 为真时出现，文案与后端 422 同文', () => {
    const many = { id: VARIABLE, name: '合成多人', enabled: true, parentId: null, multiple: true };
    expect(multipleHint('public_variable', many, true)).toBe('多人变量只能用于会签或或签节点');
    expect(multipleHint('application_variable', many, true)).toBe('多人变量只能用于会签或或签节点');
    expect(multipleHint('matrix', many, true)).toBe('允许多人的角色列只能用于会签或或签节点');
    expect(multipleHint('matrix', many, false)).toBeUndefined();
    expect(multipleHint('matrix', { ...many, multiple: false }, true)).toBeUndefined();
    expect(multipleHint('matrix', undefined, true)).toBeUndefined();
  });
  it('09 矩阵候选整份读取：每页 200 逐页读到无更多；超过 10 页截断并标记', async () => {
    const urls: string[] = [];
    const api = (pages: number) =>
      ({
        request: async (url: string) => {
          urls.push(url);
          const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
          const item = { id: `${MATRIX.slice(0, -3)}${String(page).padStart(3, '0')}`, name: `矩阵${page}` };
          return { items: [{ ...item, enabled: true, parentId: null }], page, pageSize: 200, hasMore: page < pages };
        },
      }) as unknown as ApiClient;
    const two = await readMatrixCandidates(api(2), '2026-11-14');
    expect(two.items.map((item) => item.name)).toEqual(['矩阵1', '矩阵2']);
    expect(two.hasMore).toBe(false);
    expect(new URL(urls[0]!, 'http://x').searchParams.get('pageSize')).toBe('200');
    expect(new URL(urls[1]!, 'http://x').searchParams.get('page')).toBe('2');
    urls.length = 0;
    const capped = await readMatrixCandidates(api(50), '2026-11-14');
    expect(urls).toHaveLength(10);
    expect(capped).toMatchObject({ hasMore: true });
  });
});
