/** F-326 F3（AC-APV-F326-26）：设计器三类来源取消灰显；规则与领域校验同源，候选按后端真实形状，合成 ID。 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_TYPES, type ApproverSource } from '@italent/domain';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { buildDraft, nodeField } from './model.js';
import { acceptCandidates, candidateParams, type CandidateQuery } from './source-candidates.js';
import { sourceInputError, sourceOptions } from './sources.js';

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
  it('02 矩阵只在有任职申请业务日的类型可选，其余可见但禁用并注明原因；两类变量不受类型限制', () => {
    for (const [code, type] of Object.entries(APPROVAL_TYPES)) {
      const options = sourceOptions(node(), code);
      const matrix = options.find((o) => o.value === 'matrix')!;
      if (MATRIX_ADAPTERS.includes(type.adapter))
        expect(matrix, code).toMatchObject({ disabled: false, label: '审批矩阵' });
      else expect(matrix, code).toMatchObject({ disabled: true, label: '审批矩阵 · 该审批类型不可选' });
      for (const variable of ['public_variable', 'application_variable'])
        expect(
          options.find((o) => o.value === variable),
          `${code}/${variable}`,
        ).toMatchObject({ disabled: false });
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
});
