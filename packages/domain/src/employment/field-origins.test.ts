import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_SAME_VALUE_FIELDS,
  TRUSTED_ORIGIN_KINDS,
  changedInputFields,
  deferralShape,
  effectiveOrigin,
  foldFieldOrigins,
  isTrustedSavedValue,
  projectOriginMarkers,
  requestInputFields,
  sameAsSavedValue,
  settleValueRows,
  type FieldOriginKind,
  type OriginRow,
} from './field-origins.js';

const position = 'preset:positionId';
const department = 'preset:departmentId';
const origin = (seq: bigint, originKind: FieldOriginKind, value: unknown, fieldCode = position): OriginRow => ({
  seq,
  fieldCode,
  originKind,
  value,
});
const decision = (seq: bigint, originKind: 'fallback' | 'restore', refSeq: bigint): OriginRow => ({
  ...origin(seq, originKind, null),
  refSeq,
});

describe('F-036 §4.6 字段来源领域函数', () => {
  it('策略、解析与覆盖各自挂起及恢复；最后写入遵守取值优先级', () => {
    const inherited = origin(1n, 'inherit', '继承岗位');
    const resolved = origin(2n, 'resolved', '落地岗位');
    const cleared = origin(3n, 'hr-input', null);
    const rows = [cleared, inherited, resolved];
    const state = () => foldFieldOrigins(rows).get(position)!;
    expect(effectiveOrigin(state())).toEqual({ value: null, lastWriter: cleared });
    expect(isTrustedSavedValue(state(), new Set(['inherit', 'resolved']))).toBe(false);
    expect(settleValueRows(state(), (row) => (row.seq === 1n ? undefined : false))).toEqual([
      { fieldCode: position, originKind: 'fallback', refSeq: 3n },
      { fieldCode: position, originKind: 'fallback', refSeq: 2n },
    ]);

    rows.push(decision(4n, 'fallback', 3n), decision(5n, 'fallback', 2n));
    expect(effectiveOrigin(state())).toEqual({ value: '继承岗位', lastWriter: inherited });
    expect(isTrustedSavedValue(state(), new Set(['inherit']))).toBe(true);
    rows.push(decision(6n, 'fallback', 1n));
    expect(effectiveOrigin(state())).toEqual({ value: null, lastWriter: null });
    expect(settleValueRows(state(), () => true)).toEqual([
      { fieldCode: position, originKind: 'restore', refSeq: 3n },
      { fieldCode: position, originKind: 'restore', refSeq: 2n },
      { fieldCode: position, originKind: 'restore', refSeq: 1n },
    ]);
    rows.push(decision(7n, 'restore', 2n));
    expect(effectiveOrigin(state())).toEqual({ value: '落地岗位', lastWriter: resolved });
  });

  it('更晚的继承策略行取代旧的落地解析值（转正改期重算）；延迟策略与更晚的解析值不受影响', () => {
    const resolved = origin(1n, 'resolved', '旧前驱工作地');
    const inherited = origin(2n, 'inherit', null);
    const state = (...rows: OriginRow[]) => foldFieldOrigins(rows).get(position)!;
    // 台账行都保留，只是旧解析值不再有取值效力
    expect(effectiveOrigin(state(resolved, inherited))).toEqual({ value: null, lastWriter: inherited });
    expect(state(resolved, inherited).resolved).toBe(resolved);
    expect(isTrustedSavedValue(state(resolved, inherited), new Set(['resolved']))).toBe(false);
    // 被取代的解析值不再参与适用性判定，也就不会再被退回或恢复
    expect(settleValueRows(state(resolved, inherited), () => false)).toEqual([
      { fieldCode: position, originKind: 'fallback', refSeq: 2n },
    ]);
    // 人工覆盖仍排在继承行之前
    const override = origin(3n, 'hr-input', '人工值');
    expect(effectiveOrigin(state(resolved, inherited, override)).lastWriter).toBe(override);
    // 之后再落地的解析值重新生效
    const landed = origin(3n, 'resolved', '新落地工作地');
    expect(effectiveOrigin(state(resolved, inherited, landed))).toEqual({ value: '新落地工作地', lastWriter: landed });
    // 延迟策略后续行不取代解析值
    const deferred = origin(2n, 'deferred', null);
    expect(effectiveOrigin(state(resolved, deferred))).toEqual({ value: '旧前驱工作地', lastWriter: resolved });
  });

  it('延迟形态独立于覆盖；派生、保留及状态各按投影规则处理', () => {
    const positionPolicy = origin(1n, 'deferred', null);
    const departmentPolicy = origin(2n, 'deferred', null, department);
    expect(deferralShape(foldFieldOrigins([]))).toBe('none');
    expect(deferralShape(foldFieldOrigins([positionPolicy]))).toBe('position');
    expect(deferralShape(foldFieldOrigins([departmentPolicy]))).toBe('department');
    const retained = origin(3n, 'retain', '保留岗位');
    const rows = [
      positionPolicy,
      departmentPolicy,
      retained,
      origin(4n, 'derive', '带出值', 'preset:sequenceId'),
      origin(5n, 'derive-edit', '经理', 'preset:directManagerId'),
      origin(6n, 'status-propagate', 3, 'status:employeeStatus'),
    ];
    const states = foldFieldOrigins(rows);
    expect(deferralShape(states)).toBe('both');
    expect(states.get(position)).toMatchObject({ retained: true, lastWriter: retained });
    expect(projectOriginMarkers(states)).toEqual({
      explicitFieldCodes: [position, 'preset:directManagerId'],
      deferredFieldCodes: [department],
    });
    expect(projectOriginMarkers(foldFieldOrigins([...rows, decision(7n, 'fallback', 3n)])).deferredFieldCodes).toEqual([
      position,
      department,
    ]);
    expect(foldFieldOrigins([...rows, origin(8n, 'system-input', '新岗位')]).get(position)?.retained).toBe(false);
    // §4.5：落地解析值有效时字段不再待定（含值为空的解析值）；解析值被退回后重新待定，策略形态不变。
    const landed = [positionPolicy, departmentPolicy, origin(9n, 'resolved', null)];
    expect(projectOriginMarkers(foldFieldOrigins(landed)).deferredFieldCodes).toEqual([department]);
    expect(deferralShape(foldFieldOrigins(landed))).toBe('both');
    expect(
      projectOriginMarkers(foldFieldOrigins([...landed, decision(10n, 'fallback', 9n)])).deferredFieldCodes,
    ).toEqual([position, department]);
  });

  it('请求键和变值分别判断，引用 ID 规范化不改变文本字段语义', () => {
    const id = 'abcdef01-0000-4000-8000-000000000001';
    const previous = { fields: { positionId: id, place: '原地', remarks: id }, customFields: { [id]: '不变' } };
    const body = {
      fields: { positionId: id.toUpperCase(), place: null, remarks: id.toUpperCase() },
      customFields: { [id.toUpperCase()]: '不变' },
    };
    expect(requestInputFields(body)).toEqual(new Set([position, 'preset:place', 'preset:remarks', `custom:${id}`]));
    expect(changedInputFields(previous, body)).toEqual(new Set(['preset:place', 'preset:remarks']));
    expect(changedInputFields(previous, { fields: { positionId: null } })).toEqual(new Set([position]));
    expect(changedInputFields(previous, {})).toEqual(new Set());
  });

  it('同值判定：UUID 按小写比，null 与无保存值都算空，空只等于空', () => {
    const id = 'abcdef01-0000-4000-8000-000000000001';
    expect(sameAsSavedValue(id, id.toUpperCase())).toBe(true);
    expect(sameAsSavedValue(id, 'abcdef01-0000-4000-8000-000000000002')).toBe(false);
    expect(sameAsSavedValue(null, null)).toBe(true);
    expect(sameAsSavedValue(undefined, null)).toBe(true);
    expect(sameAsSavedValue(id, null)).toBe(false);
    expect(sameAsSavedValue(null, id)).toBe(false);
    expect(sameAsSavedValue(undefined, id)).toBe(false);
    expect(sameAsSavedValue('', null)).toBe(false);
    expect([...EMPLOYEE_SAME_VALUE_FIELDS]).toEqual(['positionId', 'postId', 'levelId', 'sequenceId']);
  });

  it('可信来源集合：职位含人工来源与已保存的员工输入，职务、职级、序列只认系统类来源', () => {
    const trusted = (field: keyof typeof TRUSTED_ORIGIN_KINDS, kind: FieldOriginKind) =>
      TRUSTED_ORIGIN_KINDS[field].has(kind);
    for (const kind of ['employee-input', 'hr-input', 'approval-edit', 'hr-record'] as const) {
      expect(trusted('positionId', kind)).toBe(true);
      for (const field of ['postId', 'levelId', 'sequenceId'] as const) expect(trusted(field, kind)).toBe(false);
    }
    for (const field of ['postId', 'levelId', 'sequenceId'] as const)
      for (const kind of ['inherit', 'resolved', 'copy', 'forward-update', 'system-input', 'retain'] as const)
        expect(trusted(field, kind)).toBe(true);
    expect(trusted('sequenceId', 'sequence-sync')).toBe(true);
    expect(trusted('postId', 'sequence-sync')).toBe(false);
    expect(trusted('sequenceId', 'derive')).toBe(false);
  });
});
