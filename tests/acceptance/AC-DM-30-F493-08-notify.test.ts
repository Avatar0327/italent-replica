/**
 * AC-DM-30-F493-08/26/33/43（通知部分）：历史离职导入结束的站内通知（S3c，设计 §8.1、§10.3）。
 * 收尾事务内、仅当批次由 running 转终态的那一次发一条给提交人；completed 与 failed 都发；重复调度不重发。
 * 读写租户数据一律走 withTenant（x.q），app_owner 普通角色可过（DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { createUser, getUser, sql, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drainExitImports,
  installExitImportTestHooks,
} from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));

interface Notice {
  id: string;
  businessType: string | null;
  businessId: string | null;
  template: string | null;
  title: string | null;
  body: string | null;
  sender: string | null;
}

const rowsOfNotices = (x: ImportWorld) =>
  x.q<{
    recipient_user_id: string;
    business_type: string | null;
    business_id: string | null;
    template_code: string | null;
    payload: Record<string, string> | null;
    kind: string;
    channel: string;
  }>(x.sql`SELECT recipient_user_id::text AS recipient_user_id, business_type, business_id::text AS business_id,
      template_code, payload, kind, channel FROM approval_notifications WHERE tenant_id=${x.tenantId}
      ORDER BY created_at, id`);

const displayNameOf = async (x: ImportWorld) => (await getUser(x.db, x.session.user.id))!.displayName;

const api = (x: ImportWorld) => tenantApi(x.db, { clock: () => new Date('2026-11-05T01:00:00Z') });
const listNotices = async (x: ImportWorld): Promise<Notice[]> => {
  const response = await api(x).request('GET', '/api/tenant/approval/notifications', {
    user: x.session.user.id,
    tenant: x.tenantId,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Notice[] }).items;
};

const expireLease = (x: ImportWorld) =>
  x.q(x.sql`UPDATE exit_import_batches SET lease_until = now() - interval '1 second'
    WHERE tenant_id=${x.tenantId} AND status='running'`);

describe('AC-DM-30-F493-08 完成通知只发一次', () => {
  it('收尾后恰好 1 条给提交人（businessType / businessId / 模板 / payload），他人无通知，再调度不重发', async () => {
    const db = database().db;
    const x = await importWorld(db, '08');
    const d = await x.dept('通知部门');
    const taken = `syn.taken.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const batchId = await x.imported([x.row(1, d.code), x.row(2, d.code, { email: taken })]);
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', error_count: 1 });

    const notices = await rowsOfNotices(x);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      recipient_user_id: x.session.user.id,
      business_type: 'exit_import_batch',
      business_id: batchId,
      template_code: 'exit_import_finished',
      payload: { fileName: '合成导入.xlsx', errors: '1', senderName: await displayNameOf(x) },
    });
    expect(notices.filter((n) => n.recipient_user_id !== x.session.user.id)).toEqual([]);

    expect(await drainExitImports(db, x.tenantId)).toEqual({ batches: 0 });
    expect(await rowsOfNotices(x)).toHaveLength(1);
  });
});

describe('AC-DM-30-F493-26 系统失败批次的通知', () => {
  it('沿用 AC-11 构造使批次 failed：恰好 1 条 exit_import_finished，errors = 2；再调度不重发', async () => {
    const db = database().db;
    const x = await importWorld(db, '26');
    const d = await x.dept('失败通知部门');
    installExitImportTestHooks(db, { failRow: (n) => (n === 2 ? new Error('合成系统故障') : undefined) });
    const response = await x.submit([1, 2, 3].map((n) => x.row(n, d.code)));
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await x.settle();
    for (const _ of [2, 3, 4]) {
      await expireLease(x);
      await expect(drainExitImports(db, x.tenantId)).rejects.toThrow();
    }
    expect(await rowsOfNotices(x)).toHaveLength(0); // 未终态不发
    await expireLease(x);
    await drainExitImports(db, x.tenantId).catch(() => undefined);
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'failed', error_count: 2 });

    const notices = await rowsOfNotices(x);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      recipient_user_id: x.session.user.id,
      business_id: batchId,
      template_code: 'exit_import_finished',
      payload: { fileName: '合成导入.xlsx', errors: '2', senderName: await displayNameOf(x) },
    });
    await expireLease(x);
    await drainExitImports(db, x.tenantId);
    expect(await rowsOfNotices(x)).toHaveLength(1);
  });
});

describe('AC-DM-30-F493-33 通知正文与发送人', () => {
  it('有错误：正文逐字、模板、业务引用、sender = 提交人显示名；全成功：clean 模板；他类通知 sender = null', async () => {
    const db = database().db;
    const x = await importWorld(db, '33');
    const d = await x.dept('正文部门');
    const name = await displayNameOf(x);
    const taken = `syn.taken.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const withError = await x.imported([x.row(1, d.code), x.row(2, d.code, { email: taken })]);
    const clean = await x.imported([x.row(3, d.code)], { fileName: '干净.xlsx' });

    const notices = await listNotices(x);
    const error = notices.find((n) => n.businessId === withError)!;
    expect(error).toMatchObject({
      businessType: 'exit_import_batch',
      template: 'exit_import_finished',
      body: '合成导入.xlsx导入已结束，出现1个错误。详情请见附件。 文件将于15天后过期，请尽快下载',
      sender: name,
    });
    const ok = notices.find((n) => n.businessId === clean)!;
    expect(ok).toMatchObject({
      template: 'exit_import_finished_clean',
      body: '干净.xlsx导入已结束，出现0个错误。',
      sender: name,
    });

    // 同一用户的系统消息没有发送人
    const terminated = JSON.stringify({ flowName: '合成流程', employeeName: '合成甲', effectiveDate: '2026-11-05' });
    await x.q(x.sql`INSERT INTO approval_notifications (tenant_id, business_type, business_id, recipient_user_id,
      kind, channel, template_code, payload, command_id)
      VALUES (${x.tenantId}, 'employment', gen_random_uuid(), ${x.session.user.id}::uuid, 'message', 'inbox',
      'flow_terminated_by_exit', ${terminated}::jsonb,
      ${`syn-${uniqueSuffix()}`})`);
    const system = (await listNotices(x)).find((n) => n.template === 'flow_terminated_by_exit');
    expect(system?.sender).toBeNull();

    // 提交人改显示名后，已发出通知的 sender 不变（快照在 payload 里）
    await withPlatform(x.db, (tx) =>
      tx.execute(sql`UPDATE users SET display_name='改名后的提交人' WHERE id=${x.session.user.id}::uuid`),
    );
    expect((await listNotices(x)).find((n) => n.businessId === withError)!.sender).toBe(name);
  });

  it('文件名含控制字符：通知里已删除', async () => {
    const x = await importWorld(database().db, '33-ctl');
    const d = await x.dept('控制字符部门');
    const batchId = await x.imported([x.row(1, d.code)], { fileName: `合成\u0007\u0000导入.xlsx` });
    const [notice] = await rowsOfNotices(x);
    expect(notice!.payload!.fileName).toBe('合成导入.xlsx');
    expect((await listNotices(x)).find((n) => n.businessId === batchId)!.body).toBe(
      '合成导入.xlsx导入已结束，出现0个错误。',
    );
  });
});

describe('AC-DM-30-F493-43 错误条数进通知与操作日志（通知部分）', () => {
  it('11 行批次（成功 3 行、失败 8 行、错误 10 条）：通知正文「出现10个错误」，payload errors = 10', async () => {
    const x = await importWorld(database().db, '43');
    const d = await x.dept('条数部门');
    const cases: [string | null, string | null, string | null][] = [
      ['男', '汉族', '群众'],
      ['M', null, null],
      ['男性', null, null],
      ['abc', null, null],
      [null, '汉', null],
      [null, 'abc', null],
      [null, null, '党员'],
      [null, null, 'abc'],
      [null, null, null],
      ['女', '回族', '中共党员'],
      ['F', 'Han', '团员'],
    ];
    const batchId = await x.imported(
      cases.map(([gender, nation, politicalStatus], i) => x.row(i + 1, d.code, { gender, nation, politicalStatus })),
      { fileName: '条数.xlsx' },
    );
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 3, error_row_count: 8, error_count: 10 });
    const [notice] = await rowsOfNotices(x);
    expect(notice!.payload).toMatchObject({ fileName: '条数.xlsx', errors: '10' });
    expect((await listNotices(x))[0]!.body).toBe(
      '条数.xlsx导入已结束，出现10个错误。详情请见附件。 文件将于15天后过期，请尽快下载',
    );
  });
});
