/**
 * R2 BE-8b1 / B64 B65：离职交接设置（只存设置，不发起交接、不发催办；执行归 BE-8b2）。
 * - 离职交接事项（DEC-266③、规格 30 第 182 行）：事项类别、序号、待办类别（工作交接 / 其他）、待办事项、事项办理表单（文本或表单标识）、
 *   备注；没有适用人群和负责人；不预置原站 30 项，不做复制。
 * - 交接发起规则（DEC-266③、DEC-632）：租户设置项 exit.handover_trigger；F-250 / DEC-683 接入全部发起方式，
 *   未验证的发起人仍提示“未验证、后补”；发起人只有“员工本人”。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const KEY = 'exit.handover_trigger';

interface Item {
  readonly id: string;
  readonly category: string;
  readonly sequenceNo: number;
  readonly todoType: string;
  readonly title: string;
  readonly formRef: string | null;
  readonly remark: string | null;
  readonly revision: number;
}

async function settingsWorld(label: string) {
  const db = testDb().db;
  const session = await employmentSession(db, `handover-${label}`);
  const body = (extra: Record<string, unknown> = {}) => ({
    category: '行政',
    sequenceNo: 1,
    todoType: 'work_handover',
    title: '归还门禁卡',
    formRef: 'handover-form-admin',
    remark: '合成备注',
    ...extra,
  });
  const create = (value: unknown) => session.request('POST', '/exit-handover-items', { ifMatch: 0, body: value });
  const update = (id: string, revision: number, value: unknown) =>
    session.request('PUT', `/exit-handover-items/${id}`, { ifMatch: revision, body: value });
  const remove = (id: string, revision: number) =>
    session.request('DELETE', `/exit-handover-items/${id}`, { ifMatch: revision });
  async function list(): Promise<Item[]> {
    const response = await session.request('GET', '/exit-handover-items');
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Item[] }).items;
  }
  async function created(value: unknown): Promise<Item> {
    const response = await create(value);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Item;
  }
  const api = tenantApi(db);
  const as = { tenant: session.tenant.id, user: session.user.id };
  const read = () => api.request('GET', `/api/tenant/settings/${KEY}`, as);
  const put = (value: unknown, ifMatch = 0) =>
    api.request('PUT', `/api/tenant/settings/${KEY}`, { ...as, ifMatch, body: { value } });
  return { db, session, body, create, update, remove, list, created, read, put };
}

const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

describe('B64 离职交接事项设置', () => {
  it('新租户没有预置事项；增删改查，字段只有类别 / 序号 / 待办类别 / 待办事项 / 办理表单 / 备注，按序号排列', async () => {
    const w = await settingsWorld('items-crud');
    expect(await w.list()).toEqual([]);
    const second = await w.created(
      w.body({ category: 'IT', sequenceNo: 2, todoType: 'other', title: '回收电脑', formRef: null, remark: null }),
    );
    const first = await w.created(w.body());
    expect(Object.keys(first).sort()).toEqual(
      ['category', 'formRef', 'id', 'remark', 'revision', 'sequenceNo', 'title', 'todoType'].sort(),
    );
    expect((await w.list()).map((item) => item.id)).toEqual([first.id, second.id]);
    const edited = await w.update(first.id, first.revision, w.body({ title: '归还门禁卡与工牌', sequenceNo: 3 }));
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({
      title: '归还门禁卡与工牌',
      sequenceNo: 3,
      revision: first.revision + 1,
    });
    expect((await w.list()).map((item) => item.id)).toEqual([second.id, first.id]);
    const stale = await w.update(first.id, first.revision, w.body());
    expect(stale.status).toBe(409);
    const removed = await w.remove(second.id, second.revision);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.list()).map((item) => item.id)).toEqual([first.id]);
  });

  it('不接受适用人群、负责人等原站没有的字段；待办类别只有工作交接 / 其他；必填与长度', async () => {
    const w = await settingsWorld('items-validate');
    for (const extra of [
      { owner: '负责人' },
      { applicablePeople: ['all'] },
      { todoType: 'finance' },
      { category: '' },
      { title: '' },
      { title: '字'.repeat(201) },
      { remark: '字'.repeat(501) },
      { sequenceNo: 0 },
      { sequenceNo: 1.5 },
    ]) {
      const response = await w.create(w.body(extra));
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect((await error(response)).code).toBe('VALIDATION_FAILED');
    }
    expect(await w.list()).toEqual([]);
  });

  it('租户隔离：另一租户读不到', async () => {
    const a = await settingsWorld('items-tenant-a');
    const b = await settingsWorld('items-tenant-b');
    await a.created(a.body());
    expect(await b.list()).toEqual([]);
  });
});

describe('B65 交接发起规则设置（exit.handover_trigger）', () => {
  const valid = {
    enabled: true,
    method: 'on_approval_passed',
    includePastLastWorkDate: true,
    initiator: 'self',
    remind: { enabled: true, daysBeforeLastWorkDate: 5, daysAfterLastWorkDate: 15 },
  };

  it('系统默认值照 DEC-266③：启用、审批通过后自动发起、包含最后工作日已过的人员、员工本人、催办前 5 天 / 后 15 天', async () => {
    const w = await settingsWorld('trigger-default');
    const response = await w.read();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ key: KEY, value: valid, source: 'system', revision: 0 });
  });

  it('可保存：关闭交接、调整催办天数、不含已过人员、关闭催办', async () => {
    const w = await settingsWorld('trigger-save');
    const next = {
      ...valid,
      enabled: false,
      includePastLastWorkDate: false,
      remind: { enabled: false, daysBeforeLastWorkDate: 3, daysAfterLastWorkDate: 7 },
    };
    const saved = await w.put(next);
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ value: next, source: 'tenant', revision: 1 });
  });

  it.each([
    { method: 'manual' },
    { method: 'on_submit' },
    { method: 'on_node_approved', nodeKey: 'review' },
    { method: 'days_before_last_work_date', daysBeforeLastWorkDate: 10 },
  ])('DEC-683 发起方式 $method 可保存', async (patch) => {
    const w = await settingsWorld(`trigger-method-${patch.method}`);
    const response = await w.put({ ...valid, ...patch });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ value: { ...valid, ...patch }, revision: 1 });
  });

  it('发起人只有员工本人；其余取值、未知字段、越界天数一律 400', async () => {
    const w = await settingsWorld('trigger-invalid');
    expect(await error(await w.put({ ...valid, initiator: 'hrbp' }))).toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const value of [
      'text',
      null,
      { ...valid, method: 'unknown' },
      { ...valid, method: 'on_node_approved' },
      { ...valid, method: 'on_node_approved', nodeKey: '' },
      { ...valid, method: 'days_before_last_work_date' },
      { ...valid, method: 'days_before_last_work_date', daysBeforeLastWorkDate: -1 },
      { ...valid, extra: 1 },
      { ...valid, enabled: 'yes' },
      { ...valid, remind: { ...valid.remind, daysBeforeLastWorkDate: -1 } },
      { ...valid, remind: { ...valid.remind, daysAfterLastWorkDate: 1.5 } },
      { ...valid, remind: { ...valid.remind, daysBeforeLastWorkDate: 400 } },
      { ...valid, remind: { enabled: true } },
    ]) {
      const response = await w.put(value);
      expect(response.status, JSON.stringify(value)).toBe(400);
    }
  });
});
