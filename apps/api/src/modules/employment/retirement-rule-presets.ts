/**
 * R2 BE-5c1b 预置法定规则（R2-T04 §9.1A，DEC-641①）：每租户两条标准规则——预计退休日期（计算预计退休日期(个人身份)）
 * 与弹性范围（计算最早提前 / 最晚延迟退休日期）。覆盖全公司、优先级最低（9999，且匹配时排在自建规则之后）；
 * 默认停用：自动计算开关默认关（A-5），管理员打开开关、启用预置规则后才会被批次使用。不可编辑 / 删除，可启停、可复制。
 * 随租户开通与平台回补命令装载（DEC-361 种子登记表）。
 */
import { sql, type Tx } from '@italent/db';
import { RETIREMENT_EMPLOY_TYPES, STATUTORY_FUNCTIONS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { registerSeed } from '../../seeds/registry.js';
import {
  insertRetirementRule,
  listRetirementRules,
  lockRetirementRules,
  RETIREMENT_RULE_AUDIT_TYPE,
  type RetirementRuleInput,
} from './retirement-rules.js';
import { rowsOf } from './record-store.js';

const COMMON: Pick<
  RetirementRuleInput,
  | 'priority'
  | 'orgIds'
  | 'includeSubordinates'
  | 'retirementAgeYears'
  | 'retirementAgeMonths'
  | 'conditions'
  | 'enabled'
> = {
  priority: 9999,
  orgIds: [],
  includeSubordinates: true,
  retirementAgeYears: null,
  retirementAgeMonths: null,
  conditions: [{ fieldCode: 'employType', operator: 'in', values: [...RETIREMENT_EMPLOY_TYPES] }],
  enabled: false,
};

const PRESET_RULES: readonly { readonly code: string; readonly input: RetirementRuleInput }[] = [
  {
    code: 'expected_date_statutory',
    input: {
      ...COMMON,
      purpose: 'expected_date',
      ruleType: 'builtin',
      name: '法定退休年龄（预计退休日期）',
      expectedFunction: STATUTORY_FUNCTIONS.expectedDate,
      earliestFunction: null,
      latestFunction: null,
    },
  },
  {
    code: 'flexible_range_statutory',
    input: {
      ...COMMON,
      purpose: 'flexible_range',
      ruleType: 'builtin',
      name: '法定退休年龄（弹性退休范围）',
      expectedFunction: null,
      earliestFunction: STATUTORY_FUNCTIONS.earliest,
      latestFunction: STATUTORY_FUNCTIONS.latest,
    },
  },
];

registerSeed({
  module: 'employment-retirement',
  key: 'statutory-rules',
  version: 1,
  codes: PRESET_RULES.map((preset) => preset.code),
  existing: async (tx: Tx, tenantId) => {
    const rows = rowsOf<{ code: string }>(
      await tx.execute(sql`SELECT preset_code AS code FROM retirement_rules
        WHERE tenant_id = ${tenantId} AND preset_code IS NOT NULL`),
    );
    return new Set(rows.map((row) => row.code));
  },
  install: async (tx, write, missing) => {
    await lockRetirementRules(tx, write.tenantId);
    for (const preset of PRESET_RULES) {
      if (!missing.includes(preset.code)) continue;
      const id = await insertRetirementRule(tx, write, preset.input, { allOrgs: true, presetCode: preset.code });
      const [after] = await listRetirementRules(tx, write.tenantId, preset.input.purpose, id);
      await recordAudit(tx, {
        tenantId: write.tenantId,
        actorUserId: write.actorUserId,
        action: `${RETIREMENT_RULE_AUDIT_TYPE}.save`,
        objectType: RETIREMENT_RULE_AUDIT_TYPE,
        objectId: id,
        before: null,
        after,
        commandId: write.commandId,
        occurredAt: write.now,
      });
    }
    return { skipped: [] };
  },
});
