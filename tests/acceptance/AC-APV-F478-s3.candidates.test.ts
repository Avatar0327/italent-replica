/**
 * AC-APV-F478-16 候选接口（F-478 S3，设计 §8.2）：GET /designer/source-candidates 提供命名来源
 * subject_employee / system_admin，并按 approvalType 过滤。真实 HTTP + 真实库 + 合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type ApprovalWorld } from './AC-APV-support.js';
import { failureOf } from './AC-APV-F478-s3-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const PATH = '/api/tenant/approval/designer/source-candidates';
const SINGLE_SUBJECT = ['regularization', 'intern_regularization', 'leave', 'retirement', 'transfer'];
const MULTI_SUBJECT = ['talent_review_result', 'offer', 'offer_batch', 'org_adjustment'];

interface Item {
  id: string;
  name: string;
  enabled: boolean;
  parentId: string | null;
}

async function candidates(w: ApprovalWorld, query: string): Promise<Item[]> {
  const response = await w.request(w.hr.id, 'GET', `${PATH}?asOf=2026-10-01&${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Item[] }).items;
}
const idsOf = (items: readonly Item[]) => items.map((item) => item.id);

describe('AC-APV-F478-16 候选接口：命名来源与审批类型过滤', () => {
  it.each(SINGLE_SUBJECT)('%s：主体员工本人、系统管理员都在候选里', async (type) => {
    const w = await approvalWorld(database().db, `f478s3-cand-single-${type}`);
    const subject = await candidates(w, `type=object_field&approvalType=${type}`);
    const named = [{ id: 'subject_employee', name: '主体员工本人', enabled: true, parentId: null }];
    // F-478 S4：退休类型多一个“返聘后直线经理”命名来源（其他类型没有）
    if (type === 'retirement') {
      named.push({ id: 'rehire_direct_manager', name: '返聘后直线经理', enabled: true, parentId: null });
    }
    expect(subject).toEqual(named);
    expect(idsOf(await candidates(w, `type=identity&approvalType=${type}`))).toContain('system_admin');
  });

  it.each(MULTI_SUBJECT)('%s：多主体类型没有主体员工本人，系统管理员仍在', async (type) => {
    const w = await approvalWorld(database().db, `f478s3-cand-multi-${type}`);
    expect(await candidates(w, `type=object_field&approvalType=${type}`)).toEqual([]);
    expect(idsOf(await candidates(w, `type=identity&approvalType=${type}`))).toContain('system_admin');
  });

  it('所有审批类型都提供系统管理员；单 / 多主体划分与保存校验一致', async () => {
    const w = await approvalWorld(database().db, 'f478s3-cand-all');
    for (const type of Object.keys(APPROVAL_TYPES)) {
      const named = idsOf(await candidates(w, `type=identity&approvalType=${type}`));
      expect(
        named.filter((id) => id === 'system_admin'),
        type,
      ).toHaveLength(1);
      const subject = idsOf(await candidates(w, `type=object_field&approvalType=${type}`));
      expect(subject.includes('subject_employee'), type).toBe(!MULTI_SUBJECT.includes(type));
      expect(subject.includes('rehire_direct_manager'), type).toBe(type === 'retirement');
    }
  });

  it('不带 approvalType 不过滤；关键字按名称筛；按 ID 回查不返回命名来源；字段不多不少', async () => {
    const w = await approvalWorld(database().db, 'f478s3-cand-plain');
    expect(idsOf(await candidates(w, 'type=object_field'))).toEqual(['subject_employee']);
    const admin = await candidates(w, `type=identity&keyword=${encodeURIComponent('系统管理员')}`);
    expect(idsOf(admin)).toEqual(['system_admin']);
    expect(Object.keys(admin[0]!).sort()).toEqual(['enabled', 'id', 'name', 'parentId']);
    expect(await candidates(w, `type=identity&keyword=${encodeURIComponent('不存在的名称')}`)).toEqual([]);
    expect(await candidates(w, `type=identity&ids=${randomUUID()}`)).toEqual([]);
  });

  it('未知审批类型 → 400 VALIDATION_FAILED', async () => {
    const w = await approvalWorld(database().db, 'f478s3-cand-bad');
    const response = await w.request(w.hr.id, 'GET', `${PATH}?type=identity&asOf=2026-10-01&approvalType=nope`);
    expect(await failureOf(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('无流程编辑权限 → 403', async () => {
    const w = await approvalWorld(database().db, 'f478s3-cand-403');
    const denied = tenantApi(w.db, { authorize: () => false, clock: w.clock });
    for (const query of ['type=object_field&approvalType=regularization', 'type=identity&approvalType=leave']) {
      const response = await denied.request('GET', `${PATH}?asOf=2026-10-01&${query}`, w.as(w.hr.id));
      expect(response.status, query).toBe(403);
    }
  });

  it('跨租户隔离：他租户的身份不出现在本租户候选里（含按 ID 回查）', async () => {
    const w = await approvalWorld(database().db, 'f478s3-cand-iso-a');
    const other = await approvalWorld(database().db, 'f478s3-cand-iso-b');
    const foreign = randomUUID();
    await withTenant(other.db, other.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO permission_profiles (id,tenant_id,code,name,source)
        VALUES (${foreign}::uuid,${other.tenant.id},'F478S3ISO','合成他租户身份','standard')`),
    );
    expect(idsOf(await candidates(other, 'type=identity&approvalType=leave'))).toContain(foreign);
    expect(idsOf(await candidates(w, 'type=identity&approvalType=leave'))).not.toContain(foreign);
    expect(await candidates(w, `type=identity&ids=${foreign}`)).toEqual([]);
  });
});
