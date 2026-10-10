/**
 * 人才盘点的平台命令（F-082 契约 §6.1）：存量计算公式改绑
 * `POST /api/platform/tenants/:tenantId/talent-review/calc-formulas/rebind`（路由在 platform/routes.ts 注册）。
 * 只认平台运营身份（平台路由器统一的 platformContext）、显式指定租户、平台命令台账幂等（同 DEC-361 回补）。
 * **路由只在总开关 formulaIdBinding 打开时注册**（关闭时 404，声明也不并入）；命令开始前再做一次就绪检查：计算规则审计的来源裁剪
 * calcRuleSources 已登记，否则 503 AUDIT_REDACTOR_MISSING，不写任何数据（第二道保险，裁剪随 F082-2 合入）。
 * 返回报告 `{ rules, bound, unresolved: [{ ruleId, targetFieldId, reason }] }`：只有 ID 与原因码，不含公式原文与字段名称。
 */
import { type Db, type PlatformCommandMeta, runPlatformCommand } from '@italent/db';
import { z } from 'zod';
import { CALC_RULE_AUDIT_TYPE } from '../../audit/calc-rule-sources.js';
import { auditSourceRegistered } from '../../audit/source-registry.js';
import { AppError } from '../../errors.js';
import { defineTable } from '../../route-policy/index.js';
import { NOT_FOUND, none, platform, write } from '../../route-policy/presets.js';
import { requireTenant } from '../platform/operations.js';
import { codeOf, TALENT_REVIEW_AUDIT_ACTIONS } from './access.js';
import { type RebindInput, type RebindReport, rebindTenantCalcFormulas } from './calc-rebind.js';

export const REBIND_PATH = '/api/platform/tenants/:tenantId/talent-review/calc-formulas/rebind';
const REBIND_OP = 'tenant.talent-review.calc-formulas.rebind';
const platformCommand = write(none('平台 DTO，无字段目录'), 'platform.ledger', none('平台对象无范围'));

/** 平台策略表里本模块的声明；与路由一样只在总开关打开时并入（见 platform/routes.ts）。 */
export const TALENT_REVIEW_PLATFORM_POLICIES = defineTable('talent-review-platform', {
  // tenantId 非 UUID → 404 NOT_FOUND「租户不存在」；请求体 retryUnresolved 可选
  [`POST ${REBIND_PATH}`]: platform({ invalidId: NOT_FOUND, write: platformCommand }),
});

export const rebindBody = z.strictObject({ retryUnresolved: z.boolean().optional() });

/** 就绪检查：改绑审计的读取裁剪必须已登记；否则一律拒绝（不写任何数据）。 */
export function requireAuditRedactor(): void {
  if (!auditSourceRegistered(CALC_RULE_AUDIT_TYPE)) {
    throw new AppError('SERVICE_UNAVAILABLE', '计算规则审计的字段裁剪尚未就绪，暂不能改绑', {
      reason: 'AUDIT_REDACTOR_MISSING',
    });
  }
}

export async function rebindCalcFormulas(
  db: Db,
  tenantId: string,
  input: RebindInput,
  meta: PlatformCommandMeta,
): Promise<RebindReport> {
  requireAuditRedactor();
  await requireTenant(db, tenantId);
  return runPlatformCommand(db, meta, REBIND_OP, { tenantId, retryUnresolved: input.retryUnresolved }, async (ctx) => {
    const { report, audits } = await ctx.inTenant(tenantId, (tx) => rebindTenantCalcFormulas(tx, tenantId, input));
    // 每条有变化的规则一条审计（同事务；before / after 是原始视图，读取时按查看人裁剪）；平台审计另留一条汇总
    for (const audit of audits) {
      await ctx.auditTenant(tenantId, {
        action: `${TALENT_REVIEW_AUDIT_ACTIONS.calcRule}.rebind`,
        objectType: codeOf('calcRule'),
        objectId: audit.ruleId,
        before: audit.before,
        after: audit.after,
      });
    }
    // 无业务变化的重跑（rules = 0）不写变更汇总：命令台账照常记录，审计里不留空操作
    if (audits.length > 0) {
      await ctx.auditPlatform(
        { action: REBIND_OP, objectType: 'tenant', objectId: tenantId, before: null, after: report },
        tenantId,
      );
    }
    return report;
  });
}
