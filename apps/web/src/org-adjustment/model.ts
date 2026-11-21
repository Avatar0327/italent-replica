import { ORG_ADJUSTMENT_APPROVAL_STATUS, ORG_ADJUSTMENT_STATUS_FILTERS } from '@italent/domain';
import type { PageRequest } from '../foundation/client.js';

export const collection = '/api/tenant/org-adjustment/adjustments';
export const path = '/org/adjustments';
export const approvalPath = '/approval/org-adjustment';
export const missing = '--';

export interface RangeOrg {
  orgId: string;
  label: string | null;
  name: string | null;
}
export interface Head {
  id: string;
  code?: string;
  subject?: string;
  effectiveDate?: string;
  approvalSubjectOrgId?: string;
  approvalSubjectOrgName?: string | null;
  adjustmentRange?: RangeOrg[];
  approvalStatus?: number;
  approvalStatusLabel?: string;
  executionStatusLabel?: string;
  executionNote?: string | null;
  createdBy?: string;
  createdByName?: string | null;
  createdAt?: string;
  content?: string | null;
}
export interface Detail extends Head {
  revision: number;
  approvalInstanceId: string | null;
  contentView: { mode: string };
  sections: { org?: { count: number; hiddenRowCount: number } };
}
export interface OrgItem {
  id: string;
  adjustType?: number;
  name?: string | null;
  code?: string | null;
  shortName?: string | null;
  targetOrgName?: string | null;
  originalParentOrgName?: string | null;
  parentOrgName?: string | null;
  batchTransfer?: boolean;
  transferToOrgName?: string | null;
  stagedLabel?: string | null;
  executionResultLabel?: string | null;
  executionMessage?: string | null;
  executionReason?: string | null;
  employmentFailures?: { employeeId: string; employeeName: string; message: string }[];
  employmentFailureHiddenCount?: number;
}
export interface PreviewNode {
  key: string;
  name: string | null;
  personInChargeName: string | null;
  establishment: number | null;
  mark: 'added' | 'changed' | 'deactivated' | null;
  masked: string[];
  children: PreviewNode[];
}
export interface ExportFile {
  svg: string;
  fileName: string;
}

export const filters = {
  approvalSubjectOrgId: 'approvalSubjectOrgId',
  effectiveFrom: 'effectiveDate',
  effectiveTo: 'effectiveDate',
  approvalStatus: 'approvalStatus',
} as const;
type Filter = keyof typeof filters;
export const statusOptions = ORG_ADJUSTMENT_STATUS_FILTERS.map(({ code, label }) => ({ value: code, label }));

export function listPath(
  page: PageRequest,
  values: Partial<Record<Filter, string>>,
  visible: (field: string) => boolean,
) {
  const params = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) });
  for (const key of Object.keys(filters) as Filter[]) {
    const value = values[key];
    if (value && visible(filters[key])) params.set(key, value);
  }
  return `${collection}?${params}`;
}
export const detailPath = (id: string) => `${collection}/${encodeURIComponent(id)}`;
export const exportPath = (id: string, after: boolean) => `${detailPath(id)}/preview/export?after=${after}`;
export const display = <T extends string | number>(value: T | null | undefined) =>
  value === '' ? missing : (value ?? missing);
export const rangeLabel = (range?: RangeOrg[]) => range?.map(({ label }) => display(label)).join('、') || missing;

export function editableOrder(row: Head, userId?: string) {
  const { staged, rejected } = ORG_ADJUSTMENT_APPROVAL_STATUS;
  return !!userId && row.createdBy === userId && (row.approvalStatus === staged || row.approvalStatus === rejected);
}
export function previewRows(nodes: readonly PreviewNode[], after: boolean): PreviewNode[] {
  return nodes.flatMap((node) => {
    if (after && node.mark === 'deactivated') return [];
    return [
      {
        ...node,
        name: node.masked.includes('name') ? null : node.name,
        mark: after ? null : node.mark,
        children: previewRows(node.children, after),
      },
    ];
  });
}
export const downloadName = (name: string, format: 'png' | 'svg') =>
  `${Array.from(name, (char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '＿' : char)).join(
    '',
  )}.${format}`;
