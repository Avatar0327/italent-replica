/** F-319 / DEC-683③：列表、详情的关联名称、字段权、租户边界及批量读取。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerRealWorld, offerWorld, type OfferWorld } from './AC-OF-BE14a-support.js';
import { rowsOf, send } from './AC-OF-BE14b1-support.js';

const testDb = useTestDb();
const nameFields = {
  departmentId: ['departmentName', 'departmentFullName'],
  positionId: ['positionName'],
  postId: ['postName'],
  sentBy: ['sentByName'],
  directManagerId: ['directManagerName'],
};
const emptyNames = Object.fromEntries(
  Object.values(nameFields)
    .flat()
    .map((key) => [key, null]),
);

async function seedNames(w: OfferWorld) {
  const postId = randomUUID();
  const positionId = randomUUID();
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`INSERT INTO job_post_objects(id, tenant_id) VALUES (${postId}, ${w.tenant.id})`);
    await tx.execute(sql`INSERT INTO job_position_objects(id, tenant_id) VALUES (${positionId}, ${w.tenant.id})`);
    for (const [table, id, name] of [
      ['job_post_versions', postId, '合成职务'],
      ['job_position_versions', positionId, '合成职位'],
    ] as const) {
      const extraColumn = table === 'job_position_versions' ? sql`, org_id, post_id` : sql``;
      const extraValue = table === 'job_position_versions' ? sql`, ${w.department.id}, ${postId}` : sql``;
      await tx.execute(sql`INSERT INTO ${sql.identifier(table)}
        (tenant_id, object_id, version_no, code, name, start_date${extraColumn})
        VALUES (${w.tenant.id}, ${id}, 1, ${id}, ${name}, '2026-01-01'${extraValue}),
          (${w.tenant.id}, ${id}, 2, ${id}, ${`${name}当前`}, '2026-10-01'${extraValue}),
          (${w.tenant.id}, ${id}, 3, ${id}, ${`${name}未来`}, '2026-11-01'${extraValue})`);
    }
    await tx.execute(sql`INSERT INTO org_versions
      (tenant_id, org_id, version_no, code, name, full_name, start_date)
      VALUES (${w.tenant.id}, ${w.department.id}, 2, 'F319-DEPT', '合成部门当前', '合成集团/合成部门当前',
        '2026-10-17'),
        (${w.tenant.id}, ${w.department.id}, 3, 'F319-DEPT', '合成部门未来', '合成集团/合成部门未来',
        '2026-11-01')`);
  });
  const offer = await w.social({ postId, positionId });
  await w.force(offer.id, 'sent_by', w.user.id);
  return {
    offer,
    ids: { departmentId: w.department.id, postId, positionId, sentBy: w.user.id, directManagerId: w.manager.id },
    names: {
      departmentName: '合成部门当前',
      departmentFullName: '合成集团/合成部门当前',
      postName: '合成职务当前',
      positionName: '合成职位当前',
      sentByName: w.user.displayName,
      directManagerName: '合成员工',
    },
  };
}

async function bodyOf(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** 与现有 SQL 次数验收一致：记录实际执行语句，不记录参数或凭据。 */
function recordStatements(db: Db) {
  const session = (db as unknown as { session: { logger: unknown; options: Record<string, unknown> } }).session;
  const statements: string[] = [];
  const logger = { logQuery: (query: string) => statements.push(query) };
  const previous = { logger: session.logger, options: session.options };
  session.logger = logger;
  session.options = { ...session.options, logger };
  return {
    statements,
    stop() {
      session.logger = previous.logger;
      session.options = previous.options;
    },
  };
}

describe('AC-OF-F319 只读关联名称', () => {
  it('列表 / 详情全部名称与 ID 成对，部门名与全称不同；取当前主数据而非 Offer 入职日的未来版本', async () => {
    const w = await offerWorld(testDb().db, 'names');
    const { offer, ids, names } = await seedNames(w);
    expect(await w.get(offer.id)).toMatchObject({ ...ids, ...names });
    const list = await w.list('view=all');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: offer.id, ...ids, ...names });
    expect((await send(w, await w.get(offer.id))).status).toBe(200);
    const mail = await bodyOf(await w.request('GET', `/${offer.id}/mail`));
    expect(JSON.stringify(mail.notice)).toContain(names.departmentName);
    expect(JSON.stringify(mail.notice)).not.toContain('合成部门未来');
  });

  it('普通成员只凭对应 ID 查看权即可取得名称；逐项撤权时 ID 与名称同时消失，其他名称保留', async () => {
    const w = await offerRealWorld(testDb().db, 'names-fields');
    const { offer, names } = await seedNames(w);
    expect(await bodyOf(await w.real('GET', `/${offer.id}`))).toMatchObject(names);
    for (const [idField, labels] of Object.entries(nameFields)) {
      await w.permitObject(MODULE_OBJECTS.offer, [idField]);
      const detail = await bodyOf(await w.real('GET', `/${offer.id}`));
      const list = await bodyOf(await w.real('GET', '?view=all'));
      for (const row of [detail, ...(list.items as Record<string, unknown>[])]) {
        for (const field of [idField, ...labels]) expect(row).not.toHaveProperty(field);
        for (const [field, value] of Object.entries(names)) {
          if (!labels.includes(field)) expect(row[field], field).toBe(value);
        }
      }
    }
  });

  it('空关联 / 不存在的发送人 / 无名称版本的主数据返回 null，不回落成 ID', async () => {
    const w = await offerWorld(testDb().db, 'names-missing');
    const offer = await w.intern();
    const departmentId = randomUUID();
    const positionId = randomUUID();
    const postId = randomUUID();
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const [table, id] of [
        ['org_objects', departmentId],
        ['job_position_objects', positionId],
        ['job_post_objects', postId],
      ] as const) {
        await tx.execute(sql`INSERT INTO ${sql.identifier(table)}(id, tenant_id) VALUES (${id}, ${w.tenant.id})`);
      }
      await tx.execute(sql`UPDATE offers SET department_id = ${departmentId}, position_id = ${positionId},
        post_id = ${postId}, sent_by = ${randomUUID()} WHERE id = ${offer.id}`);
    });
    expect(await w.get(offer.id)).toMatchObject(emptyNames);
    expect((await w.list('view=all')).items[0]).toMatchObject(emptyNames);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET department_id = NULL, position_id = NULL, post_id = NULL,
        sent_by = NULL WHERE id = ${offer.id}`),
    );
    expect(await w.get(offer.id)).toMatchObject(emptyNames);
  });

  it('跨租户 Offer 404 且列表不含他租户行；历史发送人不是本租户成员时不能泄露平台账号姓名', async () => {
    const w = await offerWorld(testDb().db, 'names-tenant-a');
    const other = await offerWorld(testDb().db, 'names-tenant-b');
    const own = await seedNames(w);
    const foreign = await seedNames(other);
    expect((await w.request('GET', `/${foreign.offer.id}`)).status).toBe(404);
    await w.force(own.offer.id, 'sent_by', other.user.id);
    const detail = await w.get(own.offer.id);
    expect(detail.sentByName).toBeNull();
    const list = await w.list('view=all');
    expect(list.items.map((row) => row.id)).toEqual([own.offer.id]);
    expect(list.items[0]!.sentByName).toBeNull();
    expect(JSON.stringify(list)).not.toContain(other.user.displayName);
  });

  it('筛选继续提交 ID 并返回 label；视图区分组织全称的显示字段，不将名称当查询 ID', async () => {
    const w = await offerWorld(testDb().db, 'names-filters');
    const { offer, ids, names } = await seedNames(w);
    for (const field of ['departmentId', 'positionId', 'postId'] as const) {
      expect((await w.list(`view=unsubmitted&${field}=${ids[field]}`)).items[0]).toMatchObject({
        id: offer.id,
        ...names,
      });
      expect((await w.list(`view=unsubmitted&${field}=${randomUUID()}`)).total).toBe(0);
    }
    const views = await bodyOf(await w.request('GET', '/views'));
    const unsubmitted = (views.items as { key: string; columns: unknown[]; filters: unknown[] }[]).find(
      (view) => view.key === 'unsubmitted',
    )!;
    expect(unsubmitted.columns).toContainEqual(
      expect.objectContaining({
        label: '组织全称',
        field: 'departmentId',
        displayField: 'departmentFullName',
      }),
    );
    expect(unsubmitted.filters).toContainEqual({
      label: '部门',
      field: 'departmentId',
      displayField: 'departmentName',
    });
    expect(unsubmitted.filters).toContainEqual({ label: '职位', field: 'positionId', displayField: 'positionName' });
    expect(unsubmitted.filters).toContainEqual({ label: '职务', field: 'postId', displayField: 'postName' });
  });

  it('一页 1 / 30 条实际 SQL 次数相同，名称读取不逐行增长', async () => {
    const w = await offerWorld(testDb().db, 'names-batch');
    const { offer, names } = await seedNames(w);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO offers
      (tenant_id, entry, name, department_id, position_id, post_id, sent_by, direct_manager_id, created_by)
      SELECT tenant_id, entry, name, department_id, position_id, post_id, sent_by, direct_manager_id, created_by
      FROM offers CROSS JOIN generate_series(1, 29) WHERE id = ${offer.id}`),
    );
    const counts: number[] = [];
    for (const size of [1, 30]) {
      const capture = recordStatements(w.db);
      try {
        const list = await w.list(`view=all&pageSize=${size}`);
        expect(list.total).toBe(30);
        expect(list.items).toHaveLength(size);
        for (const row of list.items) expect(row).toMatchObject(names);
        counts.push(capture.statements.length);
      } finally {
        capture.stop();
      }
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThan(40);
    console.info('F319 HTTP 列表 SQL 次数（含事务 / 授权；1、30 条）', counts);
    const [role] = rowsOf<{ name: string; superuser: boolean; bypass: boolean }>(
      await w.db.execute(sql`SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`),
    );
    if (process.env.TEST_DATABASE_URL) expect(role).toEqual({ name: 'app_owner', superuser: false, bypass: false });
  });
});
