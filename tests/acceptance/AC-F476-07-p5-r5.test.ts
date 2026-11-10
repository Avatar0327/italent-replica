/**
 * F-476 P5 第 4 轮审查返工（PR #651）P2-1：兼职申请详情冻结读的主职分组，记录 ID（primary.id）与 primary.fields
 * 一样同时受「办理时任职对象披露上限」与「当前任职对象字段权」两道约束：办理时看不到的主职记录 ID，办理后补授权
 * 也不补露（设计 §5.2）。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import { rights } from './AC-F476-p5-support.js';

const testDb = useTestDb();
const PT = '/api/tenant/employment/part-time-requests';
const OBJECT = MODULE_OBJECTS.employmentRecord.code;

interface Primary {
  readonly id?: string;
  readonly fields: Record<string, unknown>;
}

async function partTime(label: string) {
  const w = await requestWorld(testDb().db, label);
  const r = rights(w);
  const record = await w.seedRecord({ endDate: '2026-10-31' });
  const created = await w.extend(record, '2026-12-31');
  await w.send(created.id, created.revision);
  const [first] = w.order.extend;
  const view = await w.instance(created.id);
  const live = await r.get(w.hr.id, `${PT}/${created.id}`);
  const primaryId = (live.body.primary as Primary | null)?.id;
  expect(primaryId, '现读应带主职记录 ID').toBeTruthy();
  const read = async () => {
    const res = await r.get(first!.userId, `${PT}/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.contentView?.mode).toBe('frozen');
    expect(res.body.primary, '冻结读应带主职分组').not.toBeNull();
    return res.body.primary as Primary;
  };
  return { w, r, id: created.id, instanceId: view.id, first: first!, primaryId: primaryId!, read };
}

describe('F-476 P5 R4 兼职主职记录 ID：办理时上限 ∩ 当前字段权（P2-1）', () => {
  it('办理前无 id 权 → 办理 → 补授权：冻结读仍不含主职记录 ID，主职字段照常', async () => {
    const s = await partTime('f476-r5-pt-primary-id');
    s.r.hide(OBJECT, 'id');
    await s.r.decide(s.instanceId, s.first, 'approve');
    s.r.show(OBJECT, 'id');

    const live = await s.r.get(s.w.hr.id, `${PT}/${s.id}`);
    expect((live.body.primary as Primary).id, '补授权后现读显示主职记录 ID').toBe(s.primaryId);
    const primary = await s.read();
    expect(Object.keys(primary), '办理时不可见的主职记录 ID 不得补露').not.toContain('id');
    expect(primary.fields.departmentId, '办理时可见的主职字段照常').toBe(s.w.primary);
  });

  it('办理时有 id 权：冻结读显示办理时的主职记录 ID', async () => {
    const s = await partTime('f476-r5-pt-primary-id-seen');
    await s.r.decide(s.instanceId, s.first, 'approve');
    expect((await s.read()).id).toBe(s.primaryId);
  });

  it('办理时有权、读取前撤 id 权：冻结读按当前字段权隐藏主职记录 ID', async () => {
    const s = await partTime('f476-r5-pt-primary-id-revoke');
    await s.r.decide(s.instanceId, s.first, 'approve');
    s.r.hide(OBJECT, 'id');
    const primary = await s.read();
    expect(Object.keys(primary)).not.toContain('id');
    expect(primary.fields.departmentId).toBe(s.w.primary);
  });
});
