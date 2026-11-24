/**
 * AC-TRF-72（F-036-S6 第 3 轮，设计 §4.6 J5 / §5.3）：提交与同键重放的适用性复判。
 * ① 顺序：授权 + 事务内业务写范围复核 → J5 → 返回台账缓存 / 执行。范围已收空的人看不到适用性差异：
 *    重放与首次提交都是 404、谓词一次都没被调用；范围内才由 J5 判。
 * ② 判定口径：按 §5.3 折叠后的有效值与待定状态；下层（继承值）失效而覆盖值仍适用时，保存值有效，提交放行；
 *    有效保存值确实失效才 409 FIELD_NOT_APPLICABLE。J5 只读，不追加来源行。
 * 撤权模型同 F-195/F-197：入口（事务外）放行，授权提供器只在带事务的调用里应用撤权。
 * J3“职位必须属于任职部门”由测试注入（真实版由 #99 承接）。
 */
import { useTestDb } from '@italent/testkit';
import { registerFieldApplicability } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearInjected,
  createTransfer,
  deferralWorld,
  ledger,
  patchBusiness,
  type DeferralWorld,
} from './AC-EMP-27-deferral-support.js';
import { revocable } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const POSITION = 'preset:positionId';
const BASE = '/api/tenant/employment';
const clock = () => new Date('2026-10-01T01:00:00.000Z');

afterEach(clearInjected);

/** 经可撤权授权器的提交入口：入口放行，rights 只在命令事务内生效。 */
function guardedSubmit(w: DeferralWorld) {
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  return {
    rights,
    submit: (id: string, key: string, ifMatch: number) =>
      api.request('POST', `${BASE}/businesses/${id}/submit`, { ...as, ifMatch, idempotencyKey: key, body: {} }),
  };
}

/** 注入一个可调的职位适用性谓词，并计数调用次数。 */
function probe(decide: (value: unknown) => boolean) {
  clearInjected();
  const state = { calls: 0, decide };
  const off = registerFieldApplicability(POSITION, (row) => {
    state.calls += 1;
    return state.decide(row.value);
  });
  return { state, off };
}

const draftIn = (w: DeferralWorld) => createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
const bodyText = async (response: Response) => response.clone().text();

describe('AC-TRF-72 J5 在授权与数据范围复核之后（P2：不披露范围外单据的适用性）', () => {
  it('①同键重放：事务内范围已收空 → 404，谓词未调用，状态与来源行不变', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r3-j5-replay', 'inherit');
    const draft = await draftIn(w);
    const { state, off } = probe(() => true);
    try {
      const g = guardedSubmit(w);
      const revision = (await w.business(draft.id)).revision;
      const first = await g.submit(draft.id, 'f036s6-r3-j5-replay-key', revision);
      expect(first.status, await bodyText(first)).toBe(200);
      const submitted = await w.business(draft.id);
      const origins = (await ledger(w, draft.id)).length;

      // 首次回执已在台账里；此后范围在事务内收空，且保存值此刻也已不适用
      g.rights.emptyScope = true;
      state.decide = () => false;
      state.calls = 0;
      const replay = await g.submit(draft.id, 'f036s6-r3-j5-replay-key', revision);
      expect(replay.status, await bodyText(replay)).toBe(404);
      expect(state.calls).toBe(0);
      expect(await w.business(draft.id)).toEqual(submitted);
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });

  it('②首次提交：事务内范围已收空且保存值已不适用 → 404（不是 409），谓词未调用，草稿不变', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r3-j5-first', 'inherit');
    const draft = await draftIn(w);
    const { state, off } = probe(() => false);
    try {
      const g = guardedSubmit(w);
      const before = await w.business(draft.id);
      const origins = (await ledger(w, draft.id)).length;
      g.rights.emptyScope = true;
      const response = await g.submit(draft.id, 'f036s6-r3-j5-first-key', before.revision);
      expect(response.status, await bodyText(response)).toBe(404);
      expect(state.calls).toBe(0);
      expect(await w.business(draft.id)).toEqual(before);
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });

  it('③修前合法路径仍成功：范围内首次提交 200、同键重放 200，两次都调用谓词，来源行不增', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r3-j5-legal', 'inherit');
    const draft = await draftIn(w);
    const { state, off } = probe(() => true);
    try {
      const g = guardedSubmit(w);
      const revision = (await w.business(draft.id)).revision;
      const origins = (await ledger(w, draft.id)).length;
      const first = await g.submit(draft.id, 'f036s6-r3-j5-legal-key', revision);
      expect(first.status, await bodyText(first)).toBe(200);
      expect(state.calls).toBeGreaterThan(0);

      const afterFirst = state.calls;
      const replay = await g.submit(draft.id, 'f036s6-r3-j5-legal-key', revision);
      expect(replay.status, await bodyText(replay)).toBe(200);
      expect(state.calls).toBeGreaterThan(afterFirst);
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });

  it('④范围内的同键重放：保存值此刻已不适用 → 409 FIELD_NOT_APPLICABLE，不返回缓存回执', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r3-j5-replay-stale', 'inherit');
    const draft = await draftIn(w);
    const { state, off } = probe(() => true);
    try {
      const g = guardedSubmit(w);
      const revision = (await w.business(draft.id)).revision;
      const first = await g.submit(draft.id, 'f036s6-r3-j5-replay-stale-key', revision);
      expect(first.status, await bodyText(first)).toBe(200);
      const origins = (await ledger(w, draft.id)).length;

      state.decide = () => false;
      const replay = await g.submit(draft.id, 'f036s6-r3-j5-replay-stale-key', revision);
      expect(replay.status, await bodyText(replay)).toBe(409);
      expect(await bodyText(replay)).toContain('FIELD_NOT_APPLICABLE');
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });
});

describe('AC-TRF-72 J5 按折叠后的有效保存值判定（P2：不误拒有效保存值）', () => {
  /** 草稿在 A 部门继承职位 P；HR 保存同部门覆盖值 P2；之后才注入谓词（此刻台账里还没有判定行）。 */
  async function overrideDraft(label: string) {
    const w = await deferralWorld(database().db, label, 'inherit');
    const draft = await draftIn(w);
    const saved = await patchBusiness(w, draft.id, { fields: { positionId: w.sibling.id } });
    expect(saved.status, await bodyText(saved)).toBe(200);
    expect((await w.business(draft.id)).fields.positionId).toBe(w.sibling.id);
    return { w, draft };
  }

  const submitAs = async (w: DeferralWorld, id: string, key: string) =>
    guardedSubmit(w).submit(id, key, (await w.business(id)).revision);

  it('⑤继承 P 失效、同部门覆盖 P2 仍适用：提交 200，来源行不增，职位仍是 P2', async () => {
    const { w, draft } = await overrideDraft('f036s6-r3-j5-valid-override');
    const { off } = probe((value) => value !== w.position.id);
    try {
      const origins = (await ledger(w, draft.id)).length;
      const response = await submitAs(w, draft.id, 'f036s6-r3-j5-valid-override-key');
      expect(response.status, await bodyText(response)).toBe(200);
      expect((await ledger(w, draft.id)).length).toBe(origins);
      expect((await w.business(draft.id)).fields.positionId).toBe(w.sibling.id);
    } finally {
      off();
    }
  });

  it('⑥下层判定恢复但有效值不变：先在 P 失效时保存（P 记 fallback），P 又适用后提交 → 200，来源行不增', async () => {
    const w = await deferralWorld(database().db, 'f036s6-r3-j5-restore-lower', 'inherit');
    const draft = await draftIn(w);
    let inheritApplies = false;
    clearInjected();
    const off = registerFieldApplicability(POSITION, (row) => (row.value === w.position.id ? inheritApplies : true));
    try {
      const saved = await patchBusiness(w, draft.id, { fields: { positionId: w.sibling.id } });
      expect(saved.status, await bodyText(saved)).toBe(200);
      const rows = await ledger(w, draft.id, [POSITION]);
      expect(rows.filter((row) => row.kind === 'fallback')).toHaveLength(1);

      inheritApplies = true;
      const origins = (await ledger(w, draft.id)).length;
      const response = await submitAs(w, draft.id, 'f036s6-r3-j5-restore-lower-key');
      expect(response.status, await bodyText(response)).toBe(200);
      expect((await ledger(w, draft.id)).length).toBe(origins);
      expect((await w.business(draft.id)).fields.positionId).toBe(w.sibling.id);
    } finally {
      off();
    }
  });

  it('⑦修前合法路径仍成功：继承 P 与覆盖 P2 都适用 → 提交 200', async () => {
    const { w, draft } = await overrideDraft('f036s6-r3-j5-both-valid');
    const { off } = probe(() => true);
    try {
      const response = await submitAs(w, draft.id, 'f036s6-r3-j5-both-valid-key');
      expect(response.status, await bodyText(response)).toBe(200);
    } finally {
      off();
    }
  });

  it('⑧保留：有效保存值（覆盖 P2）失效 → 409 FIELD_NOT_APPLICABLE，状态与来源行不变', async () => {
    const { w, draft } = await overrideDraft('f036s6-r3-j5-invalid-override');
    const { off } = probe((value) => value !== w.sibling.id);
    try {
      const before = await w.business(draft.id);
      const origins = (await ledger(w, draft.id)).length;
      const response = await submitAs(w, draft.id, 'f036s6-r3-j5-invalid-override-key');
      expect(response.status, await bodyText(response)).toBe(409);
      expect(await bodyText(response)).toContain('FIELD_NOT_APPLICABLE');
      expect(await w.business(draft.id)).toEqual(before);
      expect((await ledger(w, draft.id)).length).toBe(origins);
    } finally {
      off();
    }
  });

  it('⑨保留：覆盖 P2 与继承 P 都失效 → 有效值回落为空，与保存值不同 → 409', async () => {
    const { w, draft } = await overrideDraft('f036s6-r3-j5-all-invalid');
    const { off } = probe(() => false);
    try {
      const response = await submitAs(w, draft.id, 'f036s6-r3-j5-all-invalid-key');
      expect(response.status, await bodyText(response)).toBe(409);
      expect(await bodyText(response)).toContain('FIELD_NOT_APPLICABLE');
    } finally {
      off();
    }
  });
});
