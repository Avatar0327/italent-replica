/** F-474-8b §3.1：公开行政区划、无租户数据、仅 SELECT；随迁移播种。 */
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, pgTable, smallint, text } from 'drizzle-orm/pg-core';

export const adminRegions = pgTable(
  'admin_regions',
  {
    code: text('code').primaryKey(),
    parentCode: text('parent_code').references((): AnyPgColumn => adminRegions.code),
    level: smallint('level').notNull(),
    name: text('name').notNull(),
  },
  (t) => [
    check('admin_regions_level_check', sql`${t.level} BETWEEN 1 AND 3`),
    check('admin_regions_level_parent', sql`(${t.level} = 1) = (${t.parentCode} IS NULL)`),
  ],
);
