/**
 * 任职资格指标端口（R3-T02 设计 §6.2 (1)，DEC-317④ 只此一份；R3-T04 TR-R14 指标来源引用本文件，不另定）：
 * 接口与登记函数由 R3-T02 PR-0 建立，实现由 C1 登记。
 * 可信端口：在调用方租户事务内执行，有界（单次 ≤ 500）；列表方法在分页前接收调用方给出的范围谓词；`indicators`
 * 的指标内容不裁剪，调用方按自己的业务关系授权（DEC-320⑥，同人才标准端口）。
 */

export interface QualificationIndicator {
  readonly targetId: string;
  readonly code: string;
  readonly name: string;
  readonly targetTypeId: string;
  readonly targetTypePath: readonly string[];
  readonly evalMode: 'score' | 'grade';
  readonly gradeSchemeId: string | null;
  readonly weight: number | null;
  readonly targetValue: string | null;
  readonly abilities: readonly {
    readonly content: string;
    readonly targetValue: string | null;
    readonly targetGradeId: string | null;
  }[];
  readonly enabled: boolean;
}

export type QualificationIndicatorOutcome =
  | {
      readonly ok: true;
      readonly categoryId: string;
      readonly levelId: string;
      readonly data: readonly QualificationIndicator[];
    }
  | { readonly ok: false; readonly reason: 'no_current_qualification' | 'no_standard' | 'level_not_in_standard' };

/** 列表方法的分页前范围：调用方用 qualificationReadableSql(scope) 生成（C1 导出），传 sql`true` 表示不按任职资格范围过滤。 */
export type QualificationListScope = unknown; // 实现处收窄为 drizzle SQL（领域包不依赖数据库）

export interface QualificationIndicatorPort {
  indicators(
    tx: unknown,
    tenantId: string,
    employeeId: string,
    asOf: string,
    filter?: { readonly targetTypeIds?: readonly string[]; readonly targetIds?: readonly string[] },
  ): Promise<QualificationIndicatorOutcome>;
  listTargetTypes(
    tx: unknown,
    tenantId: string,
    scope: QualificationListScope,
    page: { limit: number; offset: number },
  ): Promise<readonly { id: string; name: string; parentId: string | null }[]>;
  listTargets(
    tx: unknown,
    tenantId: string,
    scope: QualificationListScope,
    page: { limit: number; offset: number; typeId?: string },
  ): Promise<readonly { id: string; code: string; name: string; typeId: string }[]>;
}

let registered: QualificationIndicatorPort | null = null;

export function registerQualificationIndicatorPort(port: QualificationIndicatorPort): void {
  registered = port;
}

/** 未登记返回 null，调用方报 400 INDICATOR_SOURCE_UNAVAILABLE（R3-T04 约定）。 */
export function qualificationIndicatorPort(): QualificationIndicatorPort | null {
  return registered;
}
