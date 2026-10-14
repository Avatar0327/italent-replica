/**
 * 胜任力库指标的取数端口（docs/02_业务建模/28 IDP-R8；口径 K-13 / K-14，DEC-307）。R3-T01（人才标准与指标库）合并后由
 * 其登记提供方：按模板模块配置的胜任力来源与计划员工，返回该来源下的指标。未登记时没有候选。
 * IDP 侧只认已启用的指标、只投影名称 / 定义 / 类别（DEC-307），提供方返回的其他字段一律丢弃。
 */
import type { Tx } from '@italent/db';
import type { CompetencySource } from '@italent/domain';

export interface CompetencyQuery {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly source: CompetencySource;
  /** 租户业务日（继任 / 轮岗 / 拟晋升等来源按计划结束时间往前取，IDP-R8）。 */
  readonly asOf: string;
  readonly plan: { readonly startDate: string; readonly endDate: string };
}

export interface CompetencyIndicator {
  readonly id: string;
  readonly name: string;
  readonly definition: string | null;
  readonly category: string | null;
  readonly enabled: boolean;
}

export type CompetencyProvider = (tx: Tx, query: CompetencyQuery) => Promise<readonly CompetencyIndicator[]>;

let provider: CompetencyProvider | undefined;

/** 登记提供方，返回注销函数（测试与模块卸载用）。 */
export function registerIdpCompetencyProvider(next: CompetencyProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = undefined;
  };
}

export interface CandidateIndicator {
  readonly id: string;
  readonly name: string;
  readonly definition: string | null;
  readonly category: string | null;
}

/** 本计划已确定来源下的已启用指标，只留 id / 名称 / 定义 / 类别（DEC-307）。 */
export async function competencyCandidates(tx: Tx, query: CompetencyQuery): Promise<CandidateIndicator[]> {
  if (!provider) return [];
  const rows = await provider(tx, query);
  return rows
    .filter((row) => row.enabled === true)
    .map(({ id, name, definition, category }) => ({
      id: id.toLowerCase(),
      name,
      definition: definition ?? null,
      category: category ?? null,
    }));
}
