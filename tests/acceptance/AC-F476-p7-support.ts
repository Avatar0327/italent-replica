/**
 * F-476 P7 验收夹具：试用期考核（试用中 / 转正）与意向退休日期申请的“办理 → 事后修改 → 已办读取”世界。
 * 内容用合成值（ZZ_ 前缀）；办理份只经 withTenant 查询（app_owner + FORCE RLS 下也能通过）。
 * 断言刻意不依赖 content 的内部形状（只用 jsonb 文本是否含某个值），形状由 P7 实现决定。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { assessmentWorld, type AssessmentWorld } from './AC-PB-BE15b1-support.js';
import { intentionWorld, type IntentionWorld } from './AC-RT-intention-support.js';
import { resultRows } from './AC-ORG-people-support.js';

export const EMPLOYMENT = '/api/tenant/employment';
export const APPROVAL = '/api/tenant/approval';
export const SELF_A = 'ZZ_自评A';
export const SELF_B = 'ZZ_自评B';
export const REASON_A = 'ZZ_意向原因A';
export const REASON_B = 'ZZ_意向原因B';

type Json = Record<string, unknown>;
interface Base {
  readonly db: Db;
  readonly tenant: { readonly id: string };
}

export interface CopyRow {
  readonly actor_user_id: string | null;
  readonly handling_kind: string;
  readonly action: string;
  readonly event: string;
  readonly text: string;
}

/** 某实例的全部办理份（按办理日志序号）；表不存在时先断言失败，不抛 SQL 错。 */
export async function copiesOf(w: Base, instanceId: string): Promise<CopyRow[]> {
  const [table] = await withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ t: string | null }>(
      await tx.execute(sql`SELECT to_regclass('approval_handling_contents')::text AS t`),
    ),
  );
  expect(table?.t, '缺少 approval_handling_contents 表').toBe('approval_handling_contents');
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<CopyRow>(
      await tx.execute(sql`SELECT c.actor_user_id::text, c.handling_kind, c.action, l.event, c.content::text AS text
        FROM approval_handling_contents c
        JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
        WHERE c.instance_id = ${instanceId}::uuid ORDER BY l.seq`),
    ),
  );
}

/** 全租户办理份总数：原子性对照用（失败的办理不得多出任何一份）。 */
export async function copyCount(w: Base): Promise<number> {
  const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_handling_contents`)),
  );
  return row!.n;
}

/** 删掉某人的办理份（可信夹具，同 AC-F476-11 的缺份场景）；ext 置空时只把内容里的 ext 抹成 null。 */
export async function sabotageCopies(w: Base, userId: string, mode: 'delete' | 'null-ext'): Promise<void> {
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
    if (mode === 'delete')
      await tx.execute(sql`DELETE FROM approval_handling_contents WHERE actor_user_id = ${userId}::uuid`);
    else
      await tx.execute(sql`UPDATE approval_handling_contents SET content = jsonb_set(content, '{ext}', 'null'::jsonb)
        WHERE actor_user_id = ${userId}::uuid`);
    await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
  });
}

export interface Read {
  readonly status: number;
  readonly body: Json;
  readonly mode: string | undefined;
  readonly code: string | undefined;
}

async function readOf(response: Response): Promise<Read> {
  const body = (await response.json()) as Json;
  const view = body.contentView as { mode?: string } | undefined;
  const error = body.error as { code?: string; details?: { reason?: string } } | undefined;
  return { status: response.status, body, mode: view?.mode, code: error?.details?.reason ?? error?.code };
}

type Requester = Pick<AssessmentWorld, 'request'>;

/** 模块自有详情（考核 / 意向申请）。 */
export const ownRead = async (w: Requester, user: string, path: string): Promise<Read> =>
  readOf(await w.request(user, 'GET', path));

/** 审批中心详情；values 是审批表单取值，另一条独立的读路径。 */
export async function centerRead(w: Requester, user: string, instanceId: string) {
  const read = await readOf(await w.request(user, 'GET', `${APPROVAL}/instances/${instanceId}`));
  const form = read.body.form as { values?: Json } | undefined;
  return { ...read, values: form?.values ?? {} };
}

/**
 * 考核：自评 A → 经理评价（opinion 等）→ 审批通过 → HR 在“审批通过后”把自评与评价改成 B（PB-R6，只改考核记录）。
 * 办理时 = A，事后 = B：员工（已办 n1）与经理（已办 n2）的“已办”都应读到办理时的值。
 */
export async function handledAssessment(
  db: Db,
  label: string,
  type: 'probation' | 'regularization',
  evaluation: Json,
  later: Json,
) {
  const w = await assessmentWorld(db, label);
  const person = await w.probationer(`${label}-员工`);
  const id = await w.launch(type, person);
  await w.complete(id, person, evaluation, SELF_A);
  const view = await w.instance(id);
  const before = await w.get(id);
  expect(before.status).toBe('approved');
  const patched = await w.patchRaw(id, before.revision, { selfEvaluation: SELF_B, ...later });
  expect(patched.status, await patched.clone().text()).toBe(200);
  return { w, person, id, instanceId: view.id, path: `${EMPLOYMENT}/probation-assessments/${id}`, before };
}
export type AssessmentScene = Awaited<ReturnType<typeof handledAssessment>>;

/**
 * 意向申请：设预计退休日期 E1 → 创建（日期 / 原因 A）→ 提交 → 直接上级驳回 → 预计退休日期改为 E2 →
 * HR 修改（日期 / 原因 B，快照刷新为 E2）。上级的“已办”应读到办理时的 A + E1，发起人读现值 B + E2。
 */
export const E1 = '2031-01-01';
export const E2 = '2031-02-01';
export async function rejectedIntention(db: Db, label: string) {
  const w = await intentionWorld(db, label);
  const facts = { earliest: '2030-01-01', latest: '2031-12-31' };
  await w.setRetirement({ expected: E1, ...facts });
  const created = await w.create({ intendedDate: '2030-03-01', reason: REASON_A });
  await w.act(created.id, 'submit');
  const instance = await w.instance(created.id);
  await w.decide(created.id, 'reject');
  await w.setRetirement({ expected: E2, ...facts });
  const current = await w.get(created.id);
  const patched = await w.patchRaw(created.id, current.revision, { intendedDate: '2030-04-01', reason: REASON_B });
  expect(patched.status, await patched.clone().text()).toBe(200);
  return { w, id: created.id, instanceId: instance.id, path: `${EMPLOYMENT}/retirement-intentions/${created.id}` };
}
export type IntentionScene = Awaited<ReturnType<typeof rejectedIntention>>;
export type { AssessmentWorld, IntentionWorld };
