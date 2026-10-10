/**
 * 种子授权补装台账（F-061，docs/08_设计/F-061_标准身份授权补装_方案.md §3.3；DEC-361 登记表的授权层）。
 * 平台通用、只追加：记下平台装过的、回补时已存在的、租户保存时动过的、因历史不明而保守不补的授权项编码，
 * 回补据此区分“目录新增、该补”与“租户撤销过、不该补回”。台账不参与鉴权，鉴权只读权限表。
 * 租户级表（RLS、只追加触发器见迁移）；主键 (tenant_id, entry, code)，写入一律 ON CONFLICT DO NOTHING，
 * 同一编码第一次登记的来源为准。
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

/**
 * install 平台装入；adopted 回补时已存在的授权纳入管理；tenant_saved 租户保存对象权限时动过；
 * withheld 首次接管时历史不足以判断、保守不补。与 apps/api 的 LedgerSource 同一枚举。
 */
export const SEED_LEDGER_SOURCES = ['install', 'adopted', 'tenant_saved', 'withheld'] as const;
export type SeedLedgerSource = (typeof SEED_LEDGER_SOURCES)[number];

export const seedGrantLedger = pgTable(
  'seed_grant_ledger',
  {
    // 默认取当前租户上下文：调用方（recordLedger）不传租户，RLS 的 WITH CHECK 保证不会写到别的租户
    tenantId: uuid('tenant_id')
      .notNull()
      .default(sql`current_tenant_id()`)
      .references(() => tenants.id),
    /** 登记项 module/key，如 permission/standard-profile-grants。 */
    entry: text('entry').notNull(),
    /** 授权项编码或标记编码（<身份>/@ledger、<身份>/<对象>/@modified）。 */
    code: text('code').notNull(),
    source: text('source').$type<SeedLedgerSource>().notNull(),
    /** 平台命令或租户写命令 ID；回补时 existing 里的登记没有写上下文，留空。 */
    commandId: text('command_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.entry, t.code] }),
    check('seed_grant_ledger_source_valid', sql`${t.source} IN ('install', 'adopted', 'tenant_saved', 'withheld')`),
  ],
);
