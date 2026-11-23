// F-481 §8.3：我的签署。形状按后端 mine.ts mineViews（列表无正文；详情多 files[].content）与 signReceipt。
import { ESIGN_BASE } from './model.js';
import { m } from './messages.js';
import { rowsOf, type Named } from './sign-model.js';

export const MINE_PATH = `${ESIGN_BASE}/mine`;
export const MINE_TABS = ['pending', 'done'] as const;
export type MineTab = (typeof MINE_TABS)[number];
export interface MineRow {
  readonly id: string;
  readonly revision: number;
  readonly status?: string;
  readonly currentNode?: string | null;
  readonly employeeSignedAt?: string | null;
  readonly enterpriseSignedAt?: string | null;
  readonly scene?: string;
  readonly initiator?: Named | null;
  readonly initiatedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly canSign?: boolean;
  readonly failureReason?: string | null;
  readonly files?: readonly { readonly seq: number; readonly templateName?: string; readonly content?: string }[];
}
export const minePath = (id: string) => `${MINE_PATH}/${encodeURIComponent(id)}`;
export const signPath = (id: string) => `${minePath(id)}/sign`;
export const mineFilesPath = (id: string) => `${minePath(id)}/files`;
export const parseMine = (raw: unknown) => rowsOf<MineRow>((raw as { items?: unknown } | null)?.items);
export const parseMineDetail = (raw: unknown) => rowsOf<MineRow>([raw])[0]!;
/** 回执须是本任务、版本为整数；否则按结果未知处理，由内核回查（DEC-067）。 */
export function parseSignReceipt(raw: unknown, id: string) {
  const receipt = raw as { id?: unknown; revision?: unknown } | null;
  if (receipt?.id !== id || !Number.isSafeInteger(receipt.revision)) throw new Error(m.mine.invalidReceipt);
  return { id };
}
/** 内核比较与回查用的快照：只取状态与当前节点（签署没有可编辑字段）。 */
export const snapshotOf = (row: MineRow) => ({
  id: row.id,
  revision: row.revision,
  values: { status: row.status, currentNode: row.currentNode },
});
