/**
 * 审计查询出口的“带出值”裁剪登记表：日志里带源对象的值或引用的对象类型，查询时按查看人当前对源对象的读取范围与源字段权裁剪。
 * 每个来源登记它覆盖的审计对象类型和一个按查看人构造的 SourceRedactor；auditSourceRegistered 供其他功能在使用前核对
 * “这类日志的裁剪已登记”（F-082 改绑命令的就绪检查，契约 §6.1）。
 */
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import { CALC_RULE_AUDIT_TYPE, calcRuleSources } from './calc-rule-sources.js';
import { qualificationSources, type SourceRedactor } from './qualification-sources.js';

export interface AuditSource {
  readonly types: ReadonlySet<string>;
  readonly create: (deps: TenantRouteDeps, ctx: TenantContext) => Promise<SourceRedactor>;
}

export const AUDIT_SOURCES: readonly AuditSource[] = [
  {
    // R3-T02 第 2 轮 P2-05、第 3 轮 R2-03：标准、等级描述、发展通道
    types: new Set([
      QUALIFICATION_OBJECTS.standard.code,
      QUALIFICATION_OBJECTS.targetGradeDescription.code,
      QUALIFICATION_OBJECTS.developmentChannel.code,
    ]),
    create: qualificationSources,
  },
  // F-082：计算规则（公式里的字段引用按查看人当前的字段目录权限裁剪，DEC-376④）
  { types: new Set([CALC_RULE_AUDIT_TYPE]), create: calcRuleSources },
];

/** 该审计对象类型的“带出值”裁剪是否已登记。 */
export const auditSourceRegistered = (objectType: string): boolean =>
  AUDIT_SOURCES.some((source) => source.types.has(objectType));

/** 本次查询涉及的审计对象类型对应的裁剪器，依次套用。 */
export async function auditRedactors(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  present: readonly string[],
): Promise<SourceRedactor['redact']> {
  const redactors = await Promise.all(
    AUDIT_SOURCES.filter((source) => present.some((type) => source.types.has(type))).map((source) =>
      source.create(deps, ctx),
    ),
  );
  return async (tx, rows) => {
    let current = [...rows];
    for (const redactor of redactors) current = await redactor.redact(tx, current);
    return current;
  };
}
