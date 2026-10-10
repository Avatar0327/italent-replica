/**
 * F-076 PR-0 契约：迁移表结构（docs/08_设计/F-076 §6；DEC-401：每租户一个网址 / 评价者 × 活动一组 / 重发即换 /
 * 会话 8 小时绝对过期；DEC-379③ 限频只有 ip / pair / tenant 三种范围）。
 * 只验库约束与隔离：凭据发放、登录、会话分别属于 PR-1 / PR-2a / PR-2b，不在这里。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

interface World {
  readonly tenantId: string;
  readonly activityId: string;
  readonly personId: string;
  readonly linkId: string;
}

let tenantNo = 0;
async function world(): Promise<World> {
  const { db } = testDb();
  const tenantId = randomUUID();
  tenantNo += 1;
  await db.execute(sql`INSERT INTO tenants (id, code, name) VALUES (${tenantId}, ${`f076-${tenantNo}`}, 'f076')`);
  const [activityId, personId, linkId, actor] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO survey360_activities (id, tenant_id, name, form, show_appraiser_name,
        role_display, owner_user_id, created_by)
      VALUES (${activityId}, ${tenantId}, '活动', 'single', true, 'name', ${actor}, ${actor})`);
    await tx.execute(sql`INSERT INTO survey360_people (id, tenant_id, name, email, source, created_by)
      VALUES (${personId}, ${tenantId}, '评价者', ${`p-${tenantNo}@example.com`}, 'manual', ${actor})`);
    await tx.execute(sql`INSERT INTO survey360_links (id, tenant_id, activity_id, kind, person_id, token_hash)
      VALUES (${linkId}, ${tenantId}, ${activityId}, 'answer', ${personId}, ${`hash-${linkId}`})`);
  });
  return { tenantId, activityId, personId, linkId };
}

/** 在租户上下文里执行一条语句，返回抛出的 SQLSTATE（成功返回 undefined），便于一行断言。 */
async function sqlState(tenantId: string, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(testDb().db, tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    return pgErrorCode(error);
  }
}

describe('AC-360-F076-00 F-076 作答链接凭据列（§6）', () => {
  it('存量链接行默认 credential_state = none、摘要为空、版本集合为空（DEC-377① 不自动补发）', async () => {
    const w = await world();
    const [row] = rows<Record<string, unknown>>(
      await withTenant(testDb().db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT credential_state, serial_lookup, password_hash, credential_key_version,
            credential_key_versions, credential_claimed_at, credential_attempts, credential_error
          FROM survey360_links WHERE id = ${w.linkId}`),
      ),
    );
    expect(row).toEqual({
      credential_state: 'none',
      serial_lookup: null,
      password_hash: null,
      credential_key_version: null,
      credential_key_versions: [],
      credential_claimed_at: null,
      credential_attempts: 0,
      credential_error: null,
    });
  });

  it('issued 当且仅当两项摘要齐全；issued 必须带当前版本且在已用版本集合内', async () => {
    const w = await world();
    const set = (clause: ReturnType<typeof sql>) =>
      sqlState(w.tenantId, sql`UPDATE survey360_links SET ${clause} WHERE id = ${w.linkId}`);

    // issued 缺摘要
    expect(
      await set(sql`credential_state = 'issued', credential_key_version = 1, credential_key_versions = '{1}'`),
    ).toBe('23514');
    // 有摘要但不是 issued
    expect(await set(sql`serial_lookup = 's', password_hash = 'p'`)).toBe('23514');
    // issued 但版本不在集合内
    expect(
      await set(sql`credential_state = 'issued', serial_lookup = 's', password_hash = 'p',
        credential_key_version = 2, credential_key_versions = '{1}'`),
    ).toBe('23514');
    // issued 缺当前版本
    expect(
      await set(
        sql`credential_state = 'issued', serial_lookup = 's', password_hash = 'p', credential_key_versions = '{1}'`,
      ),
    ).toBe('23514');
    // 合法的 issued
    expect(
      await set(sql`credential_state = 'issued', serial_lookup = 's', password_hash = 'p',
        credential_key_version = 2, credential_key_versions = '{1,2}'`),
    ).toBeUndefined();
    // 退役：摘要清空，版本与集合保留（泄露处置按集合筛选，§2.4）
    expect(await set(sql`credential_state = 'retired', serial_lookup = NULL, password_hash = NULL`)).toBeUndefined();
    // 状态取值受限
    expect(await set(sql`credential_state = 'sent'`)).toBe('23514');
  });

  it('PR-1 收紧（#220 审查 P3-2）：非 issued 时两项摘要都必须为空；版本集合不得含 NULL 元素', async () => {
    const w = await world();
    const set = (clause: ReturnType<typeof sql>) =>
      sqlState(w.tenantId, sql`UPDATE survey360_links SET ${clause} WHERE id = ${w.linkId}`);
    // pending / retired 状态只留一项摘要
    expect(await set(sql`credential_state = 'pending', serial_lookup = 's'`)).toBe('23514');
    expect(await set(sql`credential_state = 'pending', password_hash = 'p'`)).toBe('23514');
    expect(
      await set(sql`credential_state = 'retired', serial_lookup = 's', credential_key_version = 1,
        credential_key_versions = '{1}'`),
    ).toBe('23514');
    // 版本集合含 NULL：ANY 得到 NULL，旧约束放过
    expect(
      await set(sql`credential_state = 'issued', serial_lookup = 's', password_hash = 'p',
        credential_key_version = 2, credential_key_versions = ARRAY[1, NULL, 2]::smallint[]`),
    ).toBe('23514');
    expect(await set(sql`credential_key_versions = ARRAY[NULL]::smallint[]`)).toBe('23514');
    // 合法组合仍通过：issued 双摘要；retired 摘要全空
    expect(
      await set(sql`credential_state = 'issued', serial_lookup = 's', password_hash = 'p',
        credential_key_version = 2, credential_key_versions = '{1,2}'`),
    ).toBeUndefined();
    expect(await set(sql`credential_state = 'retired', serial_lookup = NULL, password_hash = NULL`)).toBeUndefined();
  });

  it('确认链接不得有凭据：kind = confirm 时 credential_state 只能是 none', async () => {
    const w = await world();
    const state = await sqlState(
      w.tenantId,
      sql`UPDATE survey360_links SET kind = 'confirm', credential_state = 'pending' WHERE id = ${w.linkId}`,
    );
    expect(state).toBe('23514');
  });

  it('序列号在租户内按（密钥版本, serial_lookup）唯一；另一版本、另一租户可以重复', async () => {
    const a = await world();
    const b = await world();
    const secondPerson = randomUUID();
    const secondLink = randomUUID();
    await withTenant(testDb().db, a.tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO survey360_people (id, tenant_id, name, email, source, created_by)
        VALUES (${secondPerson}, ${a.tenantId}, '评价者二', ${`p2-${secondPerson}@example.com`}, 'manual',
          ${randomUUID()})`);
      await tx.execute(sql`INSERT INTO survey360_links (id, tenant_id, activity_id, kind, person_id, token_hash)
        VALUES (${secondLink}, ${a.tenantId}, ${a.activityId}, 'answer', ${secondPerson}, ${`hash-${secondLink}`})`);
    });
    const issue = (tenantId: string, id: string, version: number, lookup: string) =>
      sql`UPDATE survey360_links SET credential_state = 'issued', serial_lookup = ${lookup}, password_hash = 'p',
        credential_key_version = ${version}, credential_key_versions = ARRAY[${version}]::smallint[]
        WHERE id = ${id} AND tenant_id = ${tenantId}`;

    expect(await sqlState(a.tenantId, issue(a.tenantId, a.linkId, 1, 'SAME'))).toBeUndefined();
    // 同租户、同版本、同序列号：冲突
    expect(await sqlState(a.tenantId, issue(a.tenantId, secondLink, 1, 'SAME'))).toBe('23505');
    // 同租户、另一版本：允许
    expect(await sqlState(a.tenantId, issue(a.tenantId, secondLink, 2, 'SAME'))).toBeUndefined();
    // 另一租户、同版本同值：允许
    expect(await sqlState(b.tenantId, issue(b.tenantId, b.linkId, 1, 'SAME'))).toBeUndefined();
  });
});

describe('AC-360-F076-00 F-076 作答会话（survey360_answer_sessions）', () => {
  const insertSession = (w: World, over: { linkId?: string; tokenHash?: string; tenantId?: string } = {}) =>
    sqlState(
      w.tenantId,
      sql`INSERT INTO survey360_answer_sessions (tenant_id, link_id, token_hash, created_at, expires_at)
        VALUES (${over.tenantId ?? w.tenantId}, ${over.linkId ?? w.linkId}, ${over.tokenHash ?? 'th-1'},
          now(), now() + interval '8 hours')`,
    );

  it('只存 link_id 与令牌摘要，没有版本快照列；令牌摘要按租户唯一', async () => {
    const w = await world();
    const columns = rows<{ column_name: string }>(
      await testDb().db.execute(sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'survey360_answer_sessions' ORDER BY column_name`),
    ).map((c) => c.column_name);
    expect(columns).toEqual(['created_at', 'expires_at', 'id', 'link_id', 'revoked_at', 'tenant_id', 'token_hash']);

    expect(await insertSession(w)).toBeUndefined();
    expect(await insertSession(w)).toBe('23505');
  });

  it('link_id 必须是同租户的链接行（复合外键）：不存在的链接与另一租户的链接都被拒', async () => {
    const a = await world();
    const b = await world();
    expect(await insertSession(a, { linkId: randomUUID(), tokenHash: 'x1' })).toBe('23503');
    expect(await insertSession(a, { linkId: b.linkId, tokenHash: 'x2' })).toBe('23503');
  });

  it('租户隔离：另一租户上下文看不到会话行，也写不进别人的租户', async () => {
    const a = await world();
    const b = await world();
    expect(await insertSession(a)).toBeUndefined();
    const seenByB = await withTenant(testDb().db, b.tenantId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM survey360_answer_sessions`),
    );
    expect(rows<{ n: number }>(seenByB)[0]!.n).toBe(0);
    expect(
      await sqlState(
        b.tenantId,
        sql`INSERT INTO survey360_answer_sessions
      (tenant_id, link_id, token_hash, created_at, expires_at)
      VALUES (${a.tenantId}, ${a.linkId}, 'x3', now(), now())`,
      ),
    ).toBe('42501');
  });
});

describe('AC-360-F076-00 F-076 登录限频（survey360_login_throttle，方案 C）', () => {
  const insertRow = (tenantId: string, scope: string, key: string, over: ReturnType<typeof sql> = sql``) =>
    sqlState(
      tenantId,
      sql`INSERT INTO survey360_login_throttle (tenant_id, scope, key_hash, window_started_at, updated_at,
          requests, failures)
        VALUES (${tenantId}, ${scope}, ${key}, now(), now(), 0, 0) ${over}`,
    );

  it('scope 只有 ip / pair / tenant；不预留 ip_fail、ip_bucket（DEC-379③）', async () => {
    const w = await world();
    for (const scope of ['ip', 'pair', 'tenant']) expect(await insertRow(w.tenantId, scope, scope)).toBeUndefined();
    for (const scope of ['ip_fail', 'ip_bucket', 'serial']) {
      expect(await insertRow(w.tenantId, scope, scope), scope).toBe('23514');
    }
  });

  it('主键 = （租户, scope, key_hash）；计数不得为负', async () => {
    const w = await world();
    expect(await insertRow(w.tenantId, 'ip', 'k')).toBeUndefined();
    expect(await insertRow(w.tenantId, 'ip', 'k')).toBe('23505');
    expect(
      await sqlState(w.tenantId, sql`UPDATE survey360_login_throttle SET failures = -1 WHERE key_hash = 'k'`),
    ).toBe('23514');
    expect(
      await sqlState(w.tenantId, sql`UPDATE survey360_login_throttle SET requests = -1 WHERE key_hash = 'k'`),
    ).toBe('23514');
  });
});

describe('AC-360-F076-00 F-076 安全事件（survey360_security_events，DEC-377④ 只增不改）', () => {
  const insertEvent = (tenantId: string, kind: string) =>
    sqlState(
      tenantId,
      sql`INSERT INTO survey360_security_events (tenant_id, kind, occurred_at) VALUES (${tenantId}, ${kind}, now())`,
    );

  it('九类事件可写入，其他类型被拒', async () => {
    const w = await world();
    const kinds = [
      'login_success',
      'logout',
      'lock',
      'unlock',
      'credential_issued',
      'credential_reissued',
      'credential_revoked',
      'key_rotated',
      'key_retired',
    ];
    for (const kind of kinds) expect(await insertEvent(w.tenantId, kind), kind).toBeUndefined();
    expect(await insertEvent(w.tenantId, 'login_failure')).toBe('23514');
  });

  it('应用角色没有 UPDATE / DELETE / TRUNCATE 权限；表属主执行也被触发器拒绝，行不变', async () => {
    const w = await world();
    expect(await insertEvent(w.tenantId, 'lock')).toBeUndefined();
    const statements = [
      sql`UPDATE survey360_security_events SET kind = 'unlock'`,
      sql`DELETE FROM survey360_security_events`,
      sql`TRUNCATE survey360_security_events`,
    ];
    for (const statement of statements) {
      // 应用角色：权限层先拒绝（42501）
      expect(await sqlState(w.tenantId, statement)).toBe('42501');
      // 表属主 / 超级用户：触发器兜底（55000 object_not_in_prerequisite_state）
      const owner = await testDb()
        .db.execute(statement)
        .then(
          () => undefined,
          (error: unknown) => pgErrorCode(error),
        );
      expect(owner).toBe('55000');
    }
    const left = await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT kind FROM survey360_security_events`),
    );
    expect(rows<{ kind: string }>(left)).toEqual([{ kind: 'lock' }]);
  });
});

describe('AC-360-F076-00 F-076 退役进度（survey360_key_retire_runs，§2.4.1）', () => {
  it('每租户每次运行一行，状态只有 running / done / failed', async () => {
    const w = await world();
    const runId = randomUUID();
    const insert = (status: string, run = runId) =>
      sqlState(
        w.tenantId,
        sql`INSERT INTO survey360_key_retire_runs (run_id, tenant_id, credential_key_version, compromised, status,
            started_at)
          VALUES (${run}, ${w.tenantId}, 2, false, ${status}, now())`,
      );
    expect(await insert('running')).toBeUndefined();
    expect(await insert('running')).toBe('23505');
    expect(await insert('paused', randomUUID())).toBe('23514');
    expect(
      rows<{ credentials_done: number; sessions_done: number; attempts: number }>(
        await withTenant(testDb().db, w.tenantId, (tx) =>
          tx.execute(sql`SELECT credentials_done, sessions_done, attempts FROM survey360_key_retire_runs`),
        ),
      ),
    ).toEqual([{ credentials_done: 0, sessions_done: 0, attempts: 0 }]);
  });
});
