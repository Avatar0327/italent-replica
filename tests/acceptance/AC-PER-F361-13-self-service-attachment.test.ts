/**
 * F-361② 第 2 轮返工 · 验收 13（P2-1，DEC-937，作用对象：复刻系统，合成数据）：
 * 非 HR 来源（员工自助变更）不得变更子集附件引用——新增 / 更换 / 清空在提交、同单重提、落地三处一致拒绝（403），
 * 与终审人是谁（含终审人恰为上传人）无关；普通字段修改与“原样带回现有引用”照常。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { applyApprovedChange } from '../../apps/api/src/modules/personnel/change-requests.js';
import { insert } from '../../apps/api/src/modules/personnel/store.js';
import { png, sha256, type Receipt } from './AC-ATT-support.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { newKey } from './AC-PER-F361-support.js';

const database = useTestDb();
const FIELD = 'educationCertificate';
const OTHER = 'degreeCertificate';
const BASE = '/api/tenant/approval';
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
type Subset = { id: string; revision: number } & Record<string, unknown>;
/** 详情里附件字段读出来是展开后的 { id, filename… }，没有引用时为 null */
const refId = (value: unknown) => (value as { id?: string } | null | undefined)?.id ?? null;

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school', FIELD, OTHER] } },
  });
  expect(settings.status).toBe(200);
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [
      {
        key: 'head',
        approver: { type: 'department', value: 'latest_record_department_head' },
        formFields: ['school', FIELD, OTHER],
      },
    ],
  });
  const path = `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`;
  /** HR 登记并上传一张图片（未绑定） */
  const file = async (seed: number, field = FIELD) => {
    const bytes = png(seed, seed);
    const registered = await w.json<Receipt>(
      await w.request(w.hr.id, 'POST', `${path}/attachments`, {
        body: {
          field,
          filename: 'cert.png',
          contentType: 'image/png',
          byteSize: bytes.length,
          sha256: sha256(bytes),
        },
      }),
      201,
    );
    return w.json<Receipt>(
      await w.request(w.hr.id, 'POST', `${path}/attachments/${registered.id}/upload`, {
        ifMatch: registered.revision,
        idempotencyKey: newKey(),
        body: { base64: bytes.toString('base64') },
      }),
      200,
    );
  };
  const record = async (attachment?: Receipt, other?: Receipt) =>
    w.json<Subset>(
      await w.request(w.hr.id, 'POST', path, {
        ifMatch: 0,
        body: {
          school: '甲校',
          educationLevel: '本科',
          ...(attachment ? { [FIELD]: attachment.id } : {}),
          ...(other ? { [OTHER]: other.id } : {}),
        },
      }),
      201,
    );
  const submit = (target: Subset, values: Record<string, unknown>) =>
    w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
      ifMatch: 0,
      body: {
        employeeId: s.subject.employeeId,
        subset: 'education',
        recordId: target.id,
        targetRevision: target.revision,
        values,
      },
    });
  const stored = async (id: string) => {
    const { rows } = (await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT status FROM attachment_files WHERE id=${id}::uuid`),
    )) as unknown as { rows: { status: string }[] };
    return rows[0]?.status;
  };
  const current = async (id: string) => w.json<Subset>(await w.request(w.hr.id, 'GET', `${path}/${id}`), 200);
  /** 直接写一张待审批的存量申请，再以 executor 身份落地（模拟终审） */
  const land = async (executor: string, target: Subset, values: Record<string, unknown>) => {
    const requestId = crypto.randomUUID();
    await withTenant(w.db, w.tenant.id, (tx) =>
      insert(tx, 'personnel_change_requests', {
        id: requestId,
        tenantId: w.tenant.id,
        employeeId: s.subject.employeeId,
        subset: 'education',
        recordId: target.id,
        targetRevision: target.revision,
        revision: 1,
        status: 'pending_approval',
        values: JSON.stringify(values),
        createdBy: s.subject.userId,
        commandId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      }),
    );
    const ctx = {
      tenantId: w.tenant.id,
      userId: executor,
      timezone: 'Asia/Shanghai',
      now: w.clock(),
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
    };
    return applyApprovedChange(w.db, ctx, requestId);
  };
  return { w, s, path, file, record, submit, stored, current, land };
}

describe('AC-PER-F361-13 员工自助变更不能写附件引用（P2-1，DEC-937）', () => {
  it('提交：新增 / 更换 / 清空附件引用都是 403 FORBIDDEN；普通字段与原样带回现有引用照常 201', async () => {
    const { w, file, record, submit, stored, current } = await scene('f361-self-submit');
    const existing = await file(1);
    const added = await file(2);
    const bare = await record();
    const bound = await record(existing);

    for (const [target, values] of [
      [bare, { [FIELD]: added.id }],
      [bound, { [FIELD]: added.id }],
      [bound, { [FIELD]: null }],
    ] as const) {
      const res = await submit(target, values);
      expect(res.status, await res.clone().text()).toBe(403);
      expect(await code(res)).toBe('FORBIDDEN');
    }
    expect(await stored(existing.id)).toBe('bound');
    expect(await stored(added.id)).toBe('uploaded');
    expect(refId((await current(bound.id))[FIELD])).toBe(existing.id);

    expect((await submit(bare, { school: '乙校' })).status).toBe(201);
    const same = await submit(bound, { school: '丙校', [FIELD]: existing.id });
    expect(same.status, await same.clone().text()).toBe(201);
    void w;
  });

  it('同单重提：驳回后把修正改成附件引用变更 → 403；改普通字段照常通过', async () => {
    const { w, s, file, record, submit } = await scene('f361-self-resubmit');
    const added = await file(3);
    const target = await record();
    const created = await w.json<{ id: string }>(await submit(target, { school: '乙校' }), 201);
    const view = await w.instanceOf(created.id, s.subject.userId);
    const task = view.tasks.find((t) => t.status === 'pending')!;
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, task.id, 'reject', view.revision, { comment: '请修正' }),
    );
    expect(returned.status).toBe('returned');
    const attach = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: { [FIELD]: added.id } },
    });
    expect(attach.status, await attach.clone().text()).toBe(403);
    expect(await code(attach)).toBe('FORBIDDEN');
    const ordinary = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: { school: '丁校' } },
    });
    expect(ordinary.status, await ordinary.clone().text()).toBe(200);
  });

  it('落地：存量申请里的附件引用变更，无论执行人是谁（含恰为上传人）都被拒，记录与文件不变', async () => {
    const { w, s, file, record, stored, current, land } = await scene('f361-self-apply');
    const existing = await file(4);
    const added = await file(5);
    const bare = await record();
    const bound = await record(existing);
    const cases = [
      { label: '新增', target: bare, values: { [FIELD]: added.id } },
      { label: '更换', target: bound, values: { [FIELD]: added.id } },
      { label: '清空', target: bound, values: { [FIELD]: null } },
    ];
    // 执行人：HR（即上传人）与另一名审批人
    for (const executor of [w.hr.id, s.outHead.userId]) {
      for (const item of cases) {
        await expect(
          land(executor, item.target, item.values),
          `${item.label} / 执行人 ${executor}`,
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(await stored(existing.id)).toBe('bound');
    expect(await stored(added.id)).toBe('uploaded');
    expect(refId((await current(bound.id))[FIELD])).toBe(existing.id);
    expect(refId((await current(bare.id))[FIELD])).toBeNull();
  });

  it('落地：文件集合不变、字段引用变了（两证互换 / 同一文件填入另一空字段）同样 403，记录与文件不变', async () => {
    const { w, s, file, record, stored, current, land } = await scene('f361-self-apply-same-set');
    const edu = await file(6);
    const degree = await file(7, OTHER);
    const both = await record(edu, degree);
    const single = await record(await file(8));
    const singleId = refId((await current(single.id))[FIELD])!;
    const cases = [
      { label: '两证互换', target: both, values: { [FIELD]: degree.id, [OTHER]: edu.id } },
      { label: '同一文件填入空字段', target: single, values: { [OTHER]: singleId } },
    ];
    for (const executor of [w.hr.id, s.outHead.userId]) {
      for (const item of cases) {
        await expect(
          land(executor, item.target, item.values),
          `${item.label} / 执行人 ${executor}`,
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    const afterBoth = await current(both.id);
    expect([refId(afterBoth[FIELD]), refId(afterBoth[OTHER]), afterBoth.revision]).toEqual([
      edu.id,
      degree.id,
      both.revision,
    ]);
    const afterSingle = await current(single.id);
    expect([refId(afterSingle[FIELD]), refId(afterSingle[OTHER]), afterSingle.revision]).toEqual([
      singleId,
      null,
      single.revision,
    ]);
    for (const id of [edu.id, degree.id, singleId]) expect(await stored(id)).toBe('bound');
  });

  it('提交与重提：集合不变、字段改变的载荷同样 403（与落地同一入口）', async () => {
    const { w, s, file, record, submit } = await scene('f361-self-submit-same-set');
    const edu = await file(9);
    const degree = await file(10, OTHER);
    const both = await record(edu, degree);
    const swap = await submit(both, { [FIELD]: degree.id, [OTHER]: edu.id });
    expect(swap.status, await swap.clone().text()).toBe(403);
    const dup = await submit(both, { [OTHER]: edu.id });
    expect(dup.status, await dup.clone().text()).toBe(403);
    const created = await w.json<{ id: string }>(await submit(both, { school: '乙校' }), 201);
    const view = await w.instanceOf(created.id, s.subject.userId);
    const task = view.tasks.find((t) => t.status === 'pending')!;
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, task.id, 'reject', view.revision, { comment: '请修正' }),
    );
    const res = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: { [FIELD]: degree.id, [OTHER]: edu.id } },
    });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(await code(res)).toBe('FORBIDDEN');
  });
});
