import { describe, expect, it } from 'vitest';
import {
  assessmentTypeFlow,
  contractOperationFlow,
  employmentKindFlow,
  EXIT_TERMINATION_FIXED,
  EXIT_TERMINATION_FLOW_CODES,
  EXIT_TERMINATION_PRESET,
  exitTerminationPolicy,
  partTimeRequestFlow,
  personnelSubsetFlow,
  terminatedByExit,
  validExitTerminationSetting,
} from './exit-termination.js';

const L = '2026-09-30';

describe('F-400 离职生效终止在途流程配置（DEC-725）', () => {
  it('28 类，预置只有新建合同协议不勾', () => {
    expect(EXIT_TERMINATION_FLOW_CODES).toHaveLength(28);
    expect(EXIT_TERMINATION_FLOW_CODES.filter((code) => !EXIT_TERMINATION_PRESET[code])).toEqual(['contract_create']);
  });

  it('保存校验拒绝未知键与非布尔值；读取时缺键按预置补齐，非法值回落预置', () => {
    expect(validExitTerminationSetting({ transfer: false })).toBe(true);
    expect(validExitTerminationSetting({ unknown: true })).toBe(false);
    expect(validExitTerminationSetting({ transfer: 'no' })).toBe(false);
    expect(validExitTerminationSetting([])).toBe(false);
    expect(exitTerminationPolicy({ transfer: false }).transfer).toBe(false);
    expect(exitTerminationPolicy({ transfer: false }).regularization).toBe(true);
    expect(exitTerminationPolicy({ transfer: 'no' })).toEqual(EXIT_TERMINATION_PRESET);
  });

  it('新增兼职固定终止：预置勾选、保存 false 拒绝、读到 false 仍按勾选', () => {
    expect(EXIT_TERMINATION_FIXED).toEqual(['part_time_add']);
    expect(EXIT_TERMINATION_PRESET.part_time_add).toBe(true);
    expect(validExitTerminationSetting({ part_time_add: false })).toBe(false);
    expect(validExitTerminationSetting({ part_time_add: true, transfer: false })).toBe(true);
    expect(exitTerminationPolicy({ part_time_add: false, transfer: false })).toMatchObject({
      part_time_add: true,
      transfer: false,
    });
  });

  it('业务类型映射到流程码', () => {
    expect(employmentKindFlow('intern_regularization')).toBe('intern_regularization');
    expect(employmentKindFlow('onboarding')).toBeNull();
    expect(contractOperationFlow('renew')).toBe('contract_renew');
    expect(contractOperationFlow('other')).toBeNull();
    expect(partTimeRequestFlow('extend')).toBe('part_time_extend');
    expect(assessmentTypeFlow('probation')).toBe('probation_assessment');
    expect(personnelSubsetFlow('education')).toBe('education');
    expect(personnelSubsetFlow('qualification')).toBe('emp_info_change');
    // 不在个人信息组的流程码不能借子集名混入
    expect(personnelSubsetFlow('transfer')).toBe('emp_info_change');
  });

  it('未勾选：任职 / 合同组只终止日期晚于 L（无期限视为晚于），考核与个人信息组一律保留', () => {
    const policy = exitTerminationPolicy({ transfer: false, contract_create: false, education: false });
    expect(terminatedByExit(policy, 'transfer', '2026-10-01', L)).toBe(true);
    expect(terminatedByExit(policy, 'transfer', L, L)).toBe(false);
    expect(terminatedByExit(policy, 'contract_create', null, L)).toBe(true);
    expect(terminatedByExit(policy, 'contract_create', '2026-09-01', L)).toBe(false);
    expect(terminatedByExit(policy, 'education', '2027-01-01', L)).toBe(false);
    expect(terminatedByExit(policy, 'regularization', '2026-01-01', L)).toBe(true);
  });
});
