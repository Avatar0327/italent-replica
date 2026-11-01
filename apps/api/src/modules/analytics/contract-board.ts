/**
 * 合同情况看板（B55，docs/02_业务建模/35“补充：BE-13…”）的取数。每个组件是一份候选行（id / employee_id / org_id /
 * creator_id / group_key），先套看板筛选、再叠加 DEC-177 可见谓词（boardRows）；分组计数与分页明细都从这一份行集取，
 * 数字 = 明细条数。
 * - 变动统计：已生效的初签 / 变更 / 续签 / 终止申请单，日期取生效日（终止取实际终止日）；更正（edit）与在途单不计；
 * - 签署情况：asOf 当天有效（contractInForce，与时点花名册同一谓词）、本人当天在职的合同（🟡 推测口径，见 PR 假设）；
 * - 3.1.17：人事看板 contractExpiring30 的候选集（indicatorRows），只再套看板筛选。
 */
import { sql, type Tx } from '@italent/db';
import {
  CONTRACT_BOARD_COMPONENTS,
  CONTRACT_BOARD_TOP_COMPANIES,
  SEGMENT_NONE,
  TERM_TYPE_LABELS,
} from '@italent/domain';
import type { ContractBoardCode } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { contractInForce } from '../contracts/queries.js';
import { rowsOf } from '../employment/read-model.js';
import { ratio } from './hr-structure-board.js';
import { employmentVisible, indicatorRows, inServiceFrom, pageRows, type DashboardAsOf } from './hr-dashboard.js';

export const CONTRACT_TERM_TYPES = ['fixed', 'indefinite', 'task'] as const;

export interface ContractBoardFilter {
  readonly changeFrom: string;
  readonly changeTo: string;
  readonly companyId?: string;
  readonly typeId?: string;
  readonly termType?: string;
}
export interface ContractBoardContext {
  readonly a: DashboardAsOf;
  readonly filter: ContractBoardFilter;
}

/** 看板筛选（公司 / 合同类型 / 期限类型）作用于别名 k 的合同记录或申请单。 */
function filtered(k: SQL, f: ContractBoardFilter): SQL {
  const parts = [sql`true`];
  if (f.companyId) parts.push(sql`${k}.company_id=${f.companyId}::uuid`);
  if (f.typeId) parts.push(sql`${k}.type_id=${f.typeId}::uuid`);
  if (f.termType) parts.push(sql`${k}.term_type=${f.termType}`);
  return sql.join(parts, sql` AND `);
}

const CHANGE_OPERATIONS = {
  changeCreate: 'create',
  changeChange: 'change',
  changeRenew: 'renew',
  changeTerminate: 'terminate',
} as const;

function changes({ a, filter }: ContractBoardContext, operation: string): SQL {
  return sql`SELECT q.id, q.employee_id, NULL::uuid AS org_id, q.created_by AS creator_id, NULL::text AS group_key
    FROM contract_requests q WHERE q.tenant_id=${a.tenantId} AND q.status='effective' AND q.operation=${operation}
      AND CASE WHEN q.operation='terminate' THEN q.actual_termination_date ELSE q.effective_date END
        BETWEEN ${filter.changeFrom}::date AND ${filter.changeTo}::date
      AND ${filtered(sql`q`, filter)}`;
}

const SIGN_GROUPS = {
  signByCompany: sql`k.company_id::text`,
  signByType: sql`k.type_id::text`,
  signByTermType: sql`COALESCE(k.term_type, ${SEGMENT_NONE})`,
} as const;

function signed({ a, filter }: ContractBoardContext, group: SQL): SQL {
  return sql`SELECT k.id, k.employee_id, NULL::uuid AS org_id, k.created_by AS creator_id, ${group} AS group_key
    FROM contract_records k WHERE k.tenant_id=${a.tenantId} AND ${contractInForce(sql`k`, a.asOf)}
      AND ${filtered(sql`k`, filter)}
      AND EXISTS (SELECT 1 ${inServiceFrom(a, sql`r.employee_id=k.employee_id`)})`;
}

/** 3.1.17：人事看板第 6 项的同一候选集（已按范围裁剪），再套看板筛选。 */
function expiring({ a, filter }: ContractBoardContext): SQL {
  return sql`SELECT m.id, m.employee_id, m.org_id, NULL::uuid AS creator_id, NULL::text AS group_key
    FROM (${indicatorRows('contractExpiring30', a)}) m
    JOIN contract_records k ON k.tenant_id=${a.tenantId} AND k.id=m.id
    WHERE ${filtered(sql`k`, filter)}`;
}

function candidates(code: ContractBoardCode, x: ContractBoardContext): SQL {
  if (code === '3.1.17') return expiring(x);
  if (code in CHANGE_OPERATIONS) return changes(x, CHANGE_OPERATIONS[code as keyof typeof CHANGE_OPERATIONS]);
  return signed(x, SIGN_GROUPS[code as keyof typeof SIGN_GROUPS]);
}

/** 组件的候选集（可只取一组）：范围裁剪只在这里做一次（3.1.17 的候选集本身已裁剪）。 */
function boardRows(code: ContractBoardCode, x: ContractBoardContext, group?: string): SQL {
  const visible = code === '3.1.17' ? sql`true` : employmentVisible(x.a, sql`m`);
  const only = group === undefined ? sql`true` : sql`m.group_key=${group}`;
  return sql`SELECT m.id, m.employee_id, m.org_id, m.group_key FROM (${candidates(code, x)}) m
    WHERE ${visible} AND ${only}`;
}

export const isGroupedContractComponent = (code: ContractBoardCode) => code in SIGN_GROUPS;

export function contractBoardPage(
  tx: Tx,
  code: ContractBoardCode,
  x: ContractBoardContext,
  group: string | undefined,
  page: { readonly limit: number; readonly offset: number },
) {
  return pageRows(tx, boardRows(code, x, group), page);
}

interface Named {
  readonly id: string;
  readonly name: string;
}
async function masterNames(tx: Tx, tenantId: string, table: 'contract_companies' | 'contract_types') {
  const rows = rowsOf<Named>(
    await tx.execute(sql`SELECT id::text, name FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}`),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** 8 个组件：一条语句按组件、分组计数（同一快照），再按组件形态装配。 */
export async function contractBoardComponents(tx: Tx, x: ContractBoardContext) {
  const parts = CONTRACT_BOARD_COMPONENTS.map(
    ({ code }) => sql`SELECT ${code} AS code, b.group_key AS "group", count(*)::int AS count
      FROM (${boardRows(code, x)}) b GROUP BY b.group_key`,
  );
  const counts = rowsOf<{ code: ContractBoardCode; group: string | null; count: number }>(
    await tx.execute(sql.join(parts, sql` UNION ALL `)),
  );
  const companies = await masterNames(tx, x.a.tenantId, 'contract_companies');
  const types = await masterNames(tx, x.a.tenantId, 'contract_types');
  const labels: Record<string, (key: string) => string> = {
    signByCompany: (key) => companies.get(key) ?? key,
    signByType: (key) => types.get(key) ?? key,
    signByTermType: (key) => TERM_TYPE_LABELS[key] ?? '空',
  };
  return CONTRACT_BOARD_COMPONENTS.map((component) => {
    const own = counts.filter((row) => row.code === component.code);
    const value = own.reduce((sum, row) => sum + Number(row.count), 0);
    if (!isGroupedContractComponent(component.code)) return { ...component, value, groups: null };
    const label = labels[component.code]!;
    let groups = own
      .map((row) => ({ key: row.group!, label: label(row.group!), count: Number(row.count) }))
      .sort((p, q) => q.count - p.count || p.label.localeCompare(q.label, 'zh') || p.key.localeCompare(q.key));
    if (component.code === 'signByCompany')
      return {
        ...component,
        value,
        groups: groups
          .slice(0, CONTRACT_BOARD_TOP_COMPANIES)
          .map((group) => ({ ...group, ratio: ratio(group.count, value) })),
      };
    // 期限类型三种 + 空全列（零值也列出）
    if (component.code === 'signByTermType')
      groups = [...CONTRACT_TERM_TYPES, SEGMENT_NONE].map(
        (key) => groups.find((group) => group.key === key) ?? { key, label: label(key), count: 0 },
      );
    return { ...component, value, groups };
  });
}
