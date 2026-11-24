/**
 * AC-EMP-27（F-036 S6 第 2 轮）：延迟继承与真实生产写入的衔接——部门实际解析、向后更新写出在途申请的新版本、
 * 序列同步写出在途第 2 版、落地后记录快照取最新值；postId / levelId / gradeId / sequenceId 的策略直接断言为 none。
 * 造数据全走真实入口（业务调动、/records/:id 编辑、岗位序列同步 + 作业）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import {
  createTransfer,
  deferralWorld,
  directTransfer,
  editRecord,
  ledger,
  payloadVersions,
  submitBusiness,
  type DeferralWorld,
} from './AC-EMP-27-deferral-support.js';
import { forwardJobApi } from './AC-FWD-support.js';
import { worker } from './AC-JOB-sequence-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

const states = (w: DeferralWorld, id: string) =>
  withTenant(w.db, w.session.tenant.id, (tx) => loadFieldOrigins(tx, { tenantId: w.session.tenant.id }, id));

async function land(w: DeferralWorld, draft: { id: string }, date: string) {
  await submitBusiness(w, draft.id);
  await w.approve(draft, '2026-10-01T02:00:00Z');
  const run = await w.runScheduler(`${date}T01:00:00Z`);
  expect(run).toMatchObject({ activated: [draft.id], failed: [] });
  return w.session.record(draft.id, date);
}

describe('AC-EMP-27 由职位带出的字段不延迟', () => {
  it.each(['both', 'department'] as const)(
    '%s：postId / levelId / gradeId / sequenceId 的策略为 none',
    async (shape) => {
      const w = await deferralWorld(database().db, `f036s6-r2-none-${shape}`, shape);
      const transfer = await createTransfer(w, 'direct', '2026-10-05', { departmentId: w.from.id });
      const map = await states(w, transfer.id);
      for (const code of ['postId', 'levelId', 'gradeId', 'sequenceId'])
        expect(map.get(`preset:${code}`)?.policy, code).toBe('none');
    },
  );
});

describe('AC-EMP-27 部门实际解析', () => {
  it('部门延迟：不手填部门，落地为部门记 resolved，部门先于职位解析', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-dept-resolve', 'both');
    const lateral = await directTransfer(w, '2026-10-05', {});
    const rows = await ledger(w, lateral.id);
    const resolved = rows.filter((row) => row.kind === 'resolved');
    expect(resolved.find((row) => row.field === 'preset:departmentId')).toMatchObject({
      value: w.from.id,
      source: w.hire.id,
    });
    const order = resolved.map((row) => row.field);
    expect(order.indexOf('preset:departmentId')).toBeLessThan(order.indexOf('preset:positionId'));
    expect(resolved.map((row) => BigInt(row.seq))).toEqual(resolved.map((row) => BigInt(row.seq)).sort());
    expect((await w.session.record(lateral.id, '2026-10-05')).fields).toMatchObject({ departmentId: w.from.id });
  });
});

describe('AC-EMP-27 申请路径的真实写入', () => {
  it('前驱记录被真实向后更新：申请写出新版本，落地取向后更新值，策略行不变', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-forward', 'open');
    const base = await directTransfer(w, '2026-09-15', { departmentId: w.from.id, positionId: null });
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    expect(await payloadVersions(w, draft.id)).toEqual([1]);

    await editRecord(w, base.id, { positionId: w.sibling.id });
    expect(await payloadVersions(w, draft.id)).toEqual([1, 2]);
    const forward = (await ledger(w, draft.id, ['preset:positionId'])).find((row) => row.kind === 'forward-update');
    expect(forward).toMatchObject({ value: w.sibling.id, version: 2 });
    expect((await states(w, draft.id)).get('preset:positionId')).toMatchObject({ policy: 'deferred' });

    const landed = await land(w, draft, '2026-11-01');
    expect(landed.fields).toMatchObject({ positionId: w.sibling.id });
    expect(await payloadVersions(w, draft.id)).toEqual([1, 2]);
  });

  it('岗位序列同步写出在途申请的第 2 版，落地记录取最新序列', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r2-sequence', 'both');
    const jobs = forwardJobApi(w.db, w.session);
    const initial = await jobs.create('sequences');
    const replacement = await jobs.create('sequences');
    // 草稿的职位延迟、落地时取前驱职位，所以岗位必须是前驱职位所属的岗位
    const post = w.post;
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-05T01:00:00Z') });
    const patchPost = async (ifMatch: number, body: Record<string, unknown>) => {
      const response = await api.request('PATCH', `/api/tenant/job/posts/${post.id}`, {
        tenant: w.session.tenant.id,
        user: w.session.user.id,
        ifMatch,
        body,
      });
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await patchPost(1, { sequenceId: initial.id, effectiveDate: '2026-10-02' });
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id, postId: post.id });
    await submitBusiness(w, draft.id);
    await w.approve(draft, '2026-10-01T02:00:00Z');
    expect(await payloadVersions(w, draft.id)).toEqual([1]);

    await patchPost(2, { sequenceId: replacement.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true });
    await worker(w.db, w.session.tenant.id);
    expect(await payloadVersions(w, draft.id)).toEqual([1, 2]);

    const run = await w.runScheduler('2026-11-01T01:00:00Z');
    expect(run).toMatchObject({ activated: [draft.id], failed: [] });
    const landed = await w.session.record(draft.id, '2026-11-01');
    expect(landed.fields.sequenceId).toBe(replacement.id);
    expect((await states(w, draft.id)).get('preset:sequenceId')).toMatchObject({ policy: 'none' });
  });
});
