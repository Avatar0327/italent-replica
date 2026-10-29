/**
 * BE-12b 人事看板指标 9、10、15（Offer）：待发 Offer、本月已发 Offer、Offer 审批中（规格 35 §2.1）。
 * 待发含已审批与未审批；本月已发 = 本月发出且尚未被接受 / 拒绝（状态仍是“已发”）；审批中 = 待发里审批中或审批通过。
 * 固定夹具（Offer 夹具租户今天 = 2026-10-17，Asia/Shanghai）：每个指标都断言数字 = 明细。
 */
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { dashboardClient, type DashboardClient } from './AC-HA-BE12b-support.js';
import { OF_NOW, offerWorld } from './AC-OF-BE14a-support.js';

const database = useTestDb();
const TODAY = '2026-10-17';

async function buildWorld() {
  const w = await offerWorld(database().db, 'ha-12b');
  const offer = async (approvalStatus?: string) => {
    const created = await w.social();
    if (approvalStatus) await w.force(created.id, 'approval_status', approvalStatus);
    return created;
  };
  /** 直接造数：已接受要有接受日期，已拒绝要有拒绝日期与原因（表约束）；发出时间取 sentAt。 */
  const sent = async (sentAt: string, status = 'sent') => {
    const created = await w.social();
    if (status === 'accepted') await w.force(created.id, 'accept_time', '2026-10-06');
    if (status === 'rejected') {
      await w.force(created.id, 'refusal_time', '2026-10-06');
      await w.force(created.id, 'refusal_reason_code', 'other');
    }
    await w.force(created.id, 'status', status);
    await w.force(created.id, 'sent_at', sentAt);
    return created;
  };
  const o = {
    unsubmitted: await offer(),
    approving: await offer('approving'),
    approved: await offer('approved'),
    disapproved: await offer('disapproved'),
    sentNow: await sent('2026-10-05T10:00:00+08:00'),
    sentEdge: await sent('2026-10-01T00:00:00+08:00'),
    sentLastMonth: await sent('2026-09-30T23:59:00+08:00'),
    accepted: await sent('2026-10-05T10:00:00+08:00', 'accepted'),
    rejected: await sent('2026-10-05T10:00:00+08:00', 'rejected'),
  };
  return { w, o };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('BE-12b 人事看板 Offer 指标', () => {
  let x: World;
  let board: DashboardClient;
  beforeAll(async () => {
    x = await buildWorld();
    board = dashboardClient(database().db, { tenant: x.w.tenant.id, user: x.w.user.id }, { now: () => OF_NOW });
  }, 300_000);
  const ids = (...offers: { id: string }[]) => offers.map((item) => item.id);

  it('指标 9：待发 Offer = 状态待发（含审批通过与未审批），已发、已接受、已拒绝的不计', async () => {
    const { unsubmitted, approving, approved, disapproved } = x.o;
    await board.expectIndicator('offerPending', ids(unsubmitted, approving, approved, disapproved), TODAY);
  });

  it('指标 15：Offer 审批中 = 待发里审批中或审批通过未发送；未发起、未通过的不计', async () => {
    await board.expectIndicator('offerApproving', ids(x.o.approving, x.o.approved), TODAY);
  });

  it('指标 10：本月已发 Offer = 本月发出且尚未被接受 / 拒绝；上月底发出、已接受、已拒绝的不计；月初零点算本月', async () => {
    await board.expectIndicator('offerSentThisMonth', ids(x.o.sentNow, x.o.sentEdge), TODAY);
    // 时点：10 月 3 日只有月初那份已发出
    await board.expectIndicator('offerSentThisMonth', ids(x.o.sentEdge), '2026-10-03');
  });

  it('数据范围：录用部门不在范围内的 Offer 不计，数字 = 明细', async () => {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds: [x.w.department.id],
        terms: [{ dimension: 'management', orgIds: [x.w.department.id], personIds: [] }],
      }),
      authorize: async (request) => authorize(request),
      fields: async () => new Set(),
    });
    const inScope = dashboardClient(
      database().db,
      { tenant: x.w.tenant.id, user: x.w.user.id },
      { now: () => OF_NOW, authorize },
    );
    await inScope.expectIndicator(
      'offerPending',
      ids(x.o.unsubmitted, x.o.approving, x.o.approved, x.o.disapproved),
      TODAY,
    );
    const outOfScope: Authorizer = () => true;
    registerScopeProvider(outOfScope, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds: [x.w.manager.id],
        terms: [{ dimension: 'management', orgIds: [x.w.manager.id], personIds: [] }],
      }),
      authorize: async (request) => outOfScope(request),
      fields: async () => new Set(),
    });
    const blocked = dashboardClient(
      database().db,
      { tenant: x.w.tenant.id, user: x.w.user.id },
      { now: () => OF_NOW, authorize: outOfScope },
    );
    await blocked.expectIndicator('offerPending', [], TODAY);
  });
});
