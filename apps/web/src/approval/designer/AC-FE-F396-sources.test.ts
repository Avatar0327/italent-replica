/** F-396：F-318c 新来源（7 类组织 / 职位 / 职务 + 身份）在设计器放开；规则与领域校验同源，合成 ID。 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_TYPES, type ApproverSource } from '@italent/domain';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { buildDraft, nodeField } from './model.js';
import { changeSourceType, sourceInputError, sourceOptions } from './sources.js';

const ID = 'b3960000-0000-4000-8000-000000000001';
const OPENED = ['department', 'business_org', 'profit_center', 'reserve4', 'reserve5', 'position', 'job', 'identity'];
const DIMENSIONS = ['department', 'business_org', 'profit_center', 'reserve4', 'reserve5'];
const node = () => flowFixture().latestVersion.nodes[0]!;
const error = (source: ApproverSource, code = 'transfer') => sourceInputError(source, node(), code);

describe('AC-FE-F396 新来源放开', () => {
  it('01 七类引用来源与身份可选，取值不再是“其他取值 · 待开放”', () => {
    const options = sourceOptions(node(), 'transfer');
    for (const type of OPENED) {
      const option = options.find((o) => o.value === type)!;
      expect(option, type).toMatchObject({ disabled: false, status: 'enabled' });
      expect(
        option.children.some((child) => child.status === 'pending'),
        type,
      ).toBe(false);
    }
    for (const type of ['public_variable', 'application_variable', 'matrix'])
      expect(options.find((o) => o.value === type)).toMatchObject({ disabled: true, status: 'unsupported' });
  });
  it('02 引用值按 F-318c 语法校验：本级 / 含下级 / 职务相对，其余拒绝', () => {
    for (const type of OPENED) expect(error({ type, value: ID } as ApproverSource), type).toBeUndefined();
    for (const type of DIMENSIONS)
      expect(error({ type, value: `${ID}:descendants` } as ApproverSource), type).toBeUndefined();
    expect(error({ type: 'job', value: `${ID}:relative` })).toBeUndefined();
    for (const bad of [
      { type: 'department', value: '' },
      { type: 'department', value: 'new-value' },
      { type: 'department', value: `${ID}:relative` },
      { type: 'position', value: `${ID}:descendants` },
      { type: 'position', value: `${ID}:relative` },
      { type: 'job', value: `${ID}:descendants` },
      { type: 'identity', value: `${ID}:descendants` },
    ] as ApproverSource[])
      expect(error(bad), `${bad.type}/${bad.value}`).toBeTruthy();
  });
  it('03 保存草稿：合法引用进入载荷，伪造值仍被拒；切类型清空旧值', () => {
    const flow = flowFixture();
    const field = nodeField('manager', 'approver');
    for (const type of OPENED) {
      const source = { type, value: ID } as ApproverSource;
      expect(buildDraft(flow.latestVersion, { [field]: source }, 'transfer').nodes[0], type).toMatchObject({
        approver: source,
      });
    }
    expect(() =>
      buildDraft(flow.latestVersion, { [field]: { type: 'department', value: 'new-value' } }, 'transfer'),
    ).toThrow();
    expect(changeSourceType({ type: 'department', value: ID }, 'job')).toEqual({ type: 'job', value: '' });
  });
  it('04 会签多来源可混用新旧来源且按类型值去重', () => {
    const countersign = { ...node(), kind: 'countersign' as const } as ReturnType<typeof node>;
    const a = { type: 'department', value: ID } as const;
    const b = { type: 'identity', value: ID } as const;
    expect(sourceInputError([a, b], countersign, 'transfer')).toBeUndefined();
    expect(sourceInputError([a, a], countersign, 'transfer')).toBeTruthy();
  });
  it('05 无任职业务日期的审批类型不可配组织 / 职位 / 职务引用，身份不受限', () => {
    const [code] = Object.entries(APPROVAL_TYPES).find(
      ([, type]) => !['employment', 'part_time', 'exit_handover'].includes(type.adapter),
    )!;
    const options = sourceOptions(node(), code);
    for (const type of OPENED.filter((t) => t !== 'identity')) {
      // 部门另有固定表达式取值，类型本身可能仍可选；其余类型只有引用值，必须整体不可选。
      if (type !== 'department') {
        expect(
          options.find((o) => o.value === type),
          `${code}/${type}`,
        ).toMatchObject({ disabled: true });
      }
      expect(error({ type, value: ID } as ApproverSource, code), `${code}/${type}`).toBeTruthy();
    }
    expect(options.find((o) => o.value === 'identity')).toMatchObject({ disabled: false, status: 'enabled' });
    expect(error({ type: 'identity', value: ID }, code)).toBeUndefined();
  });
  it('06 命名表达式保持原限制：交接 HR 管理员只用于离职交接', () => {
    const named = { type: 'identity', value: 'handover_hr_admin' } as const;
    expect(error(named, 'transfer')).toBeTruthy();
    expect(error(named, 'exit_handover')).toBeUndefined();
  });
});
