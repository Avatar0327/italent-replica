/**
 * AC-TRF-65（F-036-S4）：员工草稿上职位、职务、职级、序列的“同值放行”与可信来源判断（DEC-950）。
 * 设计：docs/08_设计/F-036_字段来源记录与迟到后重建_设计.md §4.6、§5.2、§7.1、§10.1。
 * 夹具：甲＝DEC-950 原例；乙＝继承四字段；乙′＝原任职没有职位；丙＝HR 改当前任职后向后更新传播。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as Commands from '../../apps/api/src/commands.js';
import { appendFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { resultRows } from './AC-ORG-people-support.js';
import { waitForLockWaiters } from './AC-TRF-F181a-support.js';
import {
  BASE,
  FOUR,
  LATER,
  betaWorld,
  ok,
  scopedHr,
  selfWorld,
  snapshotOf,
  type Fields,
  type Four,
  type SelfWorld,
} from './AC-TRF-F036S4-support.js';

// 失败后回查：让命令主事务的 guard.before 第一次抛错，runCommand 随后走 replayAfterFailure 的回查出口；
// 路径上没有 guard 时原样透传（同 AC-TRF-F181a-draft-guard）。
const hooks = vi.hoisted(() => ({ failMainTransaction: false }));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<typeof Commands>();
  return {
    ...original,
    runCommand: (...args: Parameters<typeof original.runCommand>) => {
      const [db, ctx, command] = args;
      const guard = command.guard;
      if (!hooks.failMainTransaction || !guard) return original.runCommand(db, ctx, command);
      hooks.failMainTransaction = false;
      let calls = 0;
      const flaky = {
        ...guard,
        before: async (tx: Parameters<typeof guard.before>[0]) => {
          if (calls++ === 0) throw new Error('模拟主事务并发冲突');
          await guard.before(tx);
        },
      };
      return original.runCommand(db, ctx, { ...command, guard: flaky });
    },
  };
});

const database = useTestDb();
const NEXT_DATE = '2026-11-02';

/** 夹具已移到 AC-TRF-F036S4-support.ts（AC-TRF-65 单入口回归共用）；这里只绑定本文件的测试库。 */
const snapshot = snapshotOf;
const beta = (label: string, withPosition = true) => betaWorld(database().db, label, withPosition);

const forbidden = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(403);
};

/** 甲（DEC-950 原例）：租户给员工身份开职位编辑权，员工自填职位 P1（命令 K0）后收回编辑权。 */
async function alpha(label: string) {
  const s = await selfWorld(database().db, label);
  const base = await s.catalog();
  const [p1, p2, p3] = [
    await s.jobs.position(base.post),
    await s.jobs.position(base.post),
    await s.jobs.position(base.post),
  ];
  const person = await s.employee('合成员工', {
    postId: base.post,
    sequenceId: base.sequence,
    levelId: base.level,
    positionId: base.position,
  });
  await person.positionEdit(true);
  const draft = await s.draftOf(person);
  const k0 = { key: `k0-${label}`, revision: draft.revision, body: { fields: { positionId: p1 } } };
  const first = await ok(await s.patch(person, draft.id, k0.body, k0));
  const firstBody = await first.clone().json();
  await person.positionEdit(false);
  return { s, base, p1, p2, p3, person, draft, k0, firstBody };
}
/** 甲：提交，HR（审批节点）把职位改成 P2 后驳回，单据回到 rejected。 */
async function alphaRejected(label: string) {
  const a = await alpha(label);
  await ok(await a.s.submit(a.person, a.draft.id));
  await a.s.reviewEdit(a.person, a.draft.id, { positionId: a.p2 }, true);
  expect((await a.s.show(a.draft.id)).status).toBe('rejected');
  return a;
}

describe('AC-TRF-65 ① 不带字段：只改生效日、提交都 200，职位不变', () => {
  it('甲：HR 改之前，员工只改生效日、提交都 200，职位仍是自填的 P1', async () => {
    const a = await alpha('f036s4-65-1-before');
    expect(await a.s.origin(a.draft.id, 'positionId')).toEqual({ value: a.p1, kind: 'employee-input' });
    await ok(await a.s.patch(a.person, a.draft.id, { effectiveDate: LATER }));
    await ok(await a.s.submit(a.person, a.draft.id));
    const shown = await a.s.show(a.draft.id);
    expect(shown.fields).toMatchObject({ positionId: a.p1 });
    expect(await a.s.origin(a.draft.id, 'positionId')).toEqual({ value: a.p1, kind: 'employee-input' });
  });

  it('甲：HR 改之后，员工只改生效日、再提交都 200，职位仍是 P2', async () => {
    const a = await alphaRejected('f036s4-65-1-after');
    expect(await a.s.origin(a.draft.id, 'positionId')).toEqual({ value: a.p2, kind: 'approval-edit' });
    await ok(await a.s.patch(a.person, a.draft.id, { effectiveDate: NEXT_DATE }));
    await ok(await a.s.submit(a.person, a.draft.id));
    expect((await a.s.show(a.draft.id)).fields).toMatchObject({ positionId: a.p2 });
    expect(await a.s.origin(a.draft.id, 'positionId')).toEqual({ value: a.p2, kind: 'approval-edit' });
  });
});

describe('AC-TRF-65 ② 同值正例：200，字段值、来源行数、最后写入来源不变', () => {
  it('a. 甲 HR 改后整表带 P2 并改生效日，来源仍是 approval-edit', async () => {
    const a = await alphaRejected('f036s4-65-2a');
    const before = await snapshot(a.s, a.draft.id);
    const fields = { ...before.fields } as Fields;
    const body = {
      effectiveDate: NEXT_DATE,
      fields: Object.fromEntries(FOUR.map((field) => [field, fields[field]])),
    };
    expect(body.fields).toMatchObject({ positionId: a.p2 });
    await ok(await a.s.patch(a.person, a.draft.id, body));
    const after = await snapshot(a.s, a.draft.id);
    expect(after.effectiveDate).toBe(NEXT_DATE);
    expect(after.fields).toEqual({ ...before.fields });
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.manual).toBe(before.counts.manual);
    expect(after.origins.positionId).toEqual({ value: a.p2, kind: 'approval-edit' });
  });

  it('b. 甲 HR 改前带 P1（K1）来源仍是 employee-input；收权后同键重放 K0 返回首次结果，不追加来源行', async () => {
    const a = await alpha('f036s4-65-2b');
    const before = await snapshot(a.s, a.draft.id);
    const k1 = { key: 'k1-f036s4-65-2b' };
    await ok(await a.s.patch(a.person, a.draft.id, { fields: { positionId: a.p1 }, effectiveDate: LATER }, k1));
    const after = await snapshot(a.s, a.draft.id);
    expect(after.effectiveDate).toBe(LATER);
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.manual).toBe(before.counts.manual);
    expect(after.origins.positionId).toEqual({ value: a.p1, kind: 'employee-input' });

    const replay = await ok(await a.s.patch(a.person, a.draft.id, a.k0.body, a.k0));
    expect(await replay.json()).toEqual(a.firstBody);
    expect((await snapshot(a.s, a.draft.id)).counts).toEqual(after.counts);
  });

  it('c. 乙四字段一起带、逐个带，来源仍是 inherit', async () => {
    const b = await beta('f036s4-65-2c');
    const before = await snapshot(b.s, b.draft.id);
    const same: Record<Four, string> = {
      positionId: b.base.position,
      postId: b.base.post,
      levelId: b.base.level,
      sequenceId: b.base.sequence,
    };
    await ok(await b.s.patch(b.person, b.draft.id, { fields: same, effectiveDate: LATER }));
    const together = await snapshot(b.s, b.draft.id);
    expect(together.effectiveDate).toBe(LATER);
    expect(together.fields).toEqual(before.fields);
    expect(together.origins).toEqual(before.origins);
    expect(together.counts.manual).toBe(before.counts.manual);
    for (const field of FOUR) {
      await ok(await b.s.patch(b.person, b.draft.id, { fields: { [field]: same[field] }, effectiveDate: NEXT_DATE }));
      const one = await snapshot(b.s, b.draft.id);
      expect(one.origins, field).toEqual(before.origins);
      expect(one.fields, field).toEqual(before.fields);
      expect(one.counts.manual, field).toBe(before.counts.manual);
    }
    expect(before.origins.positionId.kind).toBe('inherit');
    expect(before.origins.postId.kind).toBe('inherit');
  });

  it('d. 丙：HR 改职位与职务，向后更新写进本人草稿；员工带传播来的值，来源仍是 forward-update', async () => {
    const b = await beta('f036s4-65-2d');
    await ok(await b.s.hrEditCurrent(b.person, { postId: b.other.post, positionId: b.other.position }));
    const before = await snapshot(b.s, b.draft.id);
    expect(before.origins.positionId).toEqual({ value: b.other.position, kind: 'forward-update' });
    expect(before.origins.postId).toEqual({ value: b.other.post, kind: 'forward-update' });
    await ok(
      await b.s.patch(b.person, b.draft.id, {
        fields: { positionId: b.other.position, postId: b.other.post },
        effectiveDate: LATER,
      }),
    );
    const after = await snapshot(b.s, b.draft.id);
    expect(after.effectiveDate).toBe(LATER);
    expect(after.origins).toEqual(before.origins);
    expect(after.fields).toEqual(before.fields);
    expect(after.counts.manual).toBe(before.counts.manual);
  });

  it('e. 乙的职位、职务各带大写 UUID，按小写比较，200', async () => {
    const b = await beta('f036s4-65-2e');
    const before = await snapshot(b.s, b.draft.id);
    await ok(
      await b.s.patch(b.person, b.draft.id, {
        fields: { positionId: b.base.position.toUpperCase(), postId: b.base.post.toUpperCase() },
        effectiveDate: LATER,
      }),
    );
    const after = await snapshot(b.s, b.draft.id);
    expect(after.fields).toEqual(before.fields);
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.manual).toBe(before.counts.manual);
  });

  it('f. 乙只带同值职务：200，不是 400（扣空后无业务字段，按无变化整版重提）', async () => {
    const b = await beta('f036s4-65-2f');
    const before = await snapshot(b.s, b.draft.id);
    await ok(await b.s.patch(b.person, b.draft.id, { fields: { postId: b.base.post } }));
    const after = await snapshot(b.s, b.draft.id);
    expect(after.fields).toEqual(before.fields);
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.manual).toBe(before.counts.manual);
  });

  it('g. 乙′（原任职没有职位）带 positionId: null，200，不记显式清空', async () => {
    const b = await beta('f036s4-65-2g', false);
    const before = await snapshot(b.s, b.draft.id);
    await ok(await b.s.patch(b.person, b.draft.id, { fields: { positionId: null }, effectiveDate: LATER }));
    const after = await snapshot(b.s, b.draft.id);
    expect(after.effectiveDate).toBe(LATER);
    expect(after.fields).toEqual(before.fields);
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.manual).toBe(before.counts.manual);
  });

  it('h. 同键重放 a、c 的同值请求，结果一致，不追加来源行', async () => {
    const a = await alphaRejected('f036s4-65-2h-a');
    const aBody = { effectiveDate: NEXT_DATE, fields: { positionId: a.p2 } };
    const aOptions = { key: 'k-2h-a', revision: (await a.s.show(a.draft.id)).revision };
    const aFirst = await ok(await a.s.patch(a.person, a.draft.id, aBody, aOptions));
    const aAfter = await snapshot(a.s, a.draft.id);
    const aReplay = await ok(await a.s.patch(a.person, a.draft.id, aBody, aOptions));
    expect(await aReplay.json()).toEqual(await aFirst.json());
    expect(await snapshot(a.s, a.draft.id)).toEqual(aAfter);

    const b = await beta('f036s4-65-2h-c');
    const cBody = {
      effectiveDate: LATER,
      fields: {
        positionId: b.base.position,
        postId: b.base.post,
        levelId: b.base.level,
        sequenceId: b.base.sequence,
      },
    };
    const cOptions = { key: 'k-2h-c', revision: b.draft.revision };
    const cFirst = await ok(await b.s.patch(b.person, b.draft.id, cBody, cOptions));
    const cAfter = await snapshot(b.s, b.draft.id);
    const cReplay = await ok(await b.s.patch(b.person, b.draft.id, cBody, cOptions));
    expect(await cReplay.json()).toEqual(await cFirst.json());
    expect(await snapshot(b.s, b.draft.id)).toEqual(cAfter);
  });
});

describe('AC-TRF-65 ②′ 对照：同值字段不额外写来源', () => {
  it('带四个同值字段改期与纯改期请求，载荷版本与来源表（含策略行）增量完全一致', async () => {
    const run = async (label: string, withSame: boolean) => {
      const b = await beta(label);
      const before = await b.s.counts(b.draft.id);
      const fields = Object.fromEntries(
        FOUR.map((field) => [
          field,
          { positionId: b.base.position, postId: b.base.post, levelId: b.base.level, sequenceId: b.base.sequence }[
            field
          ],
        ]),
      );
      await ok(await b.s.patch(b.person, b.draft.id, { effectiveDate: LATER, ...(withSame ? { fields } : {}) }));
      const after = await b.s.counts(b.draft.id);
      return { versions: after.versions - before.versions, origins: after.origins - before.origins };
    };
    const control = await run('f036s4-65-2p-control', false);
    expect(control.origins).toBeGreaterThan(0);
    expect(await run('f036s4-65-2p-same', true)).toEqual(control);
  });
});

describe('AC-TRF-65 ③ 变值负例：403，单据前后一致，不记来源行', () => {
  it('a. 甲 HR 改后带 P3 并改生效日、带原先自填的 P1（当前是 P2）都 403，生效日没改', async () => {
    const a = await alphaRejected('f036s4-65-3a');
    const before = await snapshot(a.s, a.draft.id);
    for (const positionId of [a.p3, a.p1]) {
      await forbidden(await a.s.patch(a.person, a.draft.id, { fields: { positionId }, effectiveDate: NEXT_DATE }));
      expect(await snapshot(a.s, a.draft.id)).toEqual(before);
    }
  });

  it('b. 乙四个字段各自换值 / 改 null 都 403；职务、职级同值而序列换值（两同一变）也 403', async () => {
    const b = await beta('f036s4-65-3b');
    const before = await snapshot(b.s, b.draft.id);
    const changed: Record<Four, string> = {
      positionId: b.other.position,
      postId: b.other.post,
      levelId: b.other.level,
      sequenceId: b.other.sequence,
    };
    const attempts: [string, Fields][] = [
      ...FOUR.map((field): [string, Fields] => [`${field} 换值`, { [field]: changed[field] }]),
      ...FOUR.map((field): [string, Fields] => [`${field} 改 null`, { [field]: null }]),
      ['两同一变', { postId: b.base.post, levelId: b.base.level, sequenceId: b.other.sequence }],
    ];
    for (const [name, fields] of attempts) {
      const response = await b.s.patch(b.person, b.draft.id, { fields, effectiveDate: LATER });
      expect(response.status, `${name} ${await response.clone().text()}`).toBe(403);
      expect(await snapshot(b.s, b.draft.id), name).toEqual(before);
    }
  });

  it('c. 乙′（原任职没有职位）带非空职位 403', async () => {
    const b = await beta('f036s4-65-3c', false);
    const before = await snapshot(b.s, b.draft.id);
    await forbidden(
      await b.s.patch(b.person, b.draft.id, { fields: { positionId: b.other.position }, effectiveDate: LATER }),
    );
    expect(await snapshot(b.s, b.draft.id)).toEqual(before);
  });
});

describe('AC-TRF-65 ④ 新建、预览带这四个字段任一个（值、null、大写 UUID）→ 403', () => {
  /** 四个入口：通用员工入口的新建与预览、本人入口 /self-service/transfer 的新建与预览。 */
  const ENTRIES = [
    { name: '通用新建', path: (id: string) => `${BASE}/transfers/employees/${id}`, generic: true, ifMatch: true },
    { name: '通用预览', path: (id: string) => `${BASE}/transfers/employees/${id}/preview`, generic: true },
    { name: '本人新建', path: () => '/api/tenant/self-service/transfer', ifMatch: true },
    { name: '本人预览', path: () => '/api/tenant/self-service/transfer/preview' },
  ] as const;

  it('四个入口 × 四字段 × 三种值（同值、null、大写 UUID）全部 403，不因同值放行', async () => {
    const b = await beta('f036s4-65-4');
    const same: Record<Four, string> = {
      positionId: b.base.position,
      postId: b.base.post,
      levelId: b.base.level,
      sequenceId: b.base.sequence,
    };
    const revision = async () =>
      (
        await b.s.w.json<{ employee: { revision: number } }>(
          await b.s.api.request('GET', '/api/tenant/self-service/profile', b.s.w.as(b.person.userId)),
        )
      ).employee.revision;
    const seen: string[] = [];
    for (const entry of ENTRIES)
      for (const field of FOUR)
        for (const value of [same[field], null, same[field].toUpperCase()]) {
          const fields = { departmentId: b.s.source, [field]: value };
          const body =
            'generic' in entry
              ? {
                  initiator: 'employee',
                  transferTypeCode: 'in_department',
                  formId: 'TenantBase.TransferMultiFormView',
                  effectiveDate: LATER,
                  mode: 'application',
                  submit: false,
                  fields,
                }
              : { effectiveDate: LATER, fields };
          const response = await b.s.api.request('POST', entry.path(b.person.employeeId), {
            ...b.s.w.as(b.person.userId),
            ...('ifMatch' in entry ? { ifMatch: await revision() } : {}),
            body,
          });
          const kind = value === null ? 'null' : value === same[field] ? 'same' : 'upper';
          seen.push(`${entry.name} ${field} ${kind} ${response.status}`);
        }
    expect(seen.filter((line) => !line.endsWith(' 403'))).toEqual([]);
    expect(seen).toHaveLength(ENTRIES.length * FOUR.length * 3);
  });

  it('通用员工预览：无职位编辑权时字段权限 403 先于表单校验；租户开了职位编辑权则照常预览（DEC-205）', async () => {
    const a = await alpha('f036s4-65-4-dec205');
    await a.person.positionEdit(false);
    const preview = (positionId: unknown) =>
      a.s.api.request('POST', `${BASE}/transfers/employees/${a.person.employeeId}/preview`, {
        ...a.s.w.as(a.person.userId),
        body: {
          initiator: 'employee',
          transferTypeCode: 'in_department',
          formId: 'TenantBase.TransferMultiFormView',
          effectiveDate: LATER,
          mode: 'application',
          submit: false,
          fields: { departmentId: a.s.source, positionId },
        },
      });
    await forbidden(await preview(a.p1));
    await a.person.positionEdit(true);
    const allowed = await preview(a.p1);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });
});

describe('AC-TRF-65 ④′ 通用员工预览只按请求里真正编辑的业务字段判写权（第 3 轮 P2-3）', () => {
  /** 只授生效日、部门、职位编辑权：initiator / transferTypeCode / formId / mode 等路由参数没有编辑权。 */
  async function minimal(label: string) {
    const s = await selfWorld(database().db, label);
    const base = await s.catalog();
    const person = await s.employee(
      '合成员工',
      { postId: base.post, sequenceId: base.sequence, levelId: base.level, positionId: base.position },
      ['effectiveDate', 'departmentId', 'positionId'],
    );
    await person.positionEdit(true);
    const preview = (fields: Fields) =>
      s.api.request('POST', `${BASE}/transfers/employees/${person.employeeId}/preview`, {
        ...s.w.as(person.userId),
        body: {
          initiator: 'employee',
          transferTypeCode: 'in_department',
          formId: 'TenantBase.TransferMultiFormView',
          effectiveDate: LATER,
          mode: 'application',
          submit: false,
          fields: { departmentId: s.source, ...fields },
        },
      });
    return { s, base, person, preview };
  }

  it('最小字段授权 + 职位编辑权：带职位的预览与省略职位的预览都是 200', async () => {
    const m = await minimal('f036s4-65-4p-allow');
    for (const [name, fields] of [
      ['带职位', { positionId: m.base.position }],
      ['省略职位', {}],
    ] as const) {
      const response = await m.preview(fields);
      expect(response.status, `${name} ${await response.clone().text()}`).toBe(200);
    }
  });

  it('同一最小授权收回职位编辑权后，带职位的预览仍是 403（字段权限先于表单校验）', async () => {
    const m = await minimal('f036s4-65-4p-deny');
    await m.person.positionEdit(false);
    await forbidden(await m.preview({ positionId: m.base.position }));
  });
});

describe('AC-TRF-65 ⑤ 重放按重放当刻比', () => {
  it('K1（带 P1）当时通过，HR 把职位改成 P2 后同键重放 K1 → 403，不返回缓存', async () => {
    const a = await alpha('f036s4-65-5');
    const k1 = {
      key: 'k1-f036s4-65-5',
      revision: (await a.s.show(a.draft.id)).revision,
      body: { fields: { positionId: a.p1 }, effectiveDate: LATER },
    };
    await ok(await a.s.patch(a.person, a.draft.id, k1.body, k1));
    await ok(await a.s.submit(a.person, a.draft.id));
    await a.s.reviewEdit(a.person, a.draft.id, { positionId: a.p2 }, true);
    const before = await snapshot(a.s, a.draft.id);
    await forbidden(await a.s.patch(a.person, a.draft.id, k1.body, k1));
    expect(await snapshot(a.s, a.draft.id)).toEqual(before);
  });
});

/**
 * ⑦ 保存值来源不可信时，同值也是 403（J2 单独判拒，DEC-987 方案 A，用户已确认）。
 * 产品没有真实入口能给员工单据的职级写入“人工来源”：夹具在测试里直接给草稿的职级追加一条来源行，产品写入口保持原样。
 * 同单据其余字段（职位、职务、序列）的来源仍是可信的 inherit，所以“任一字段可信即放行”的错误实现也会被这条用例打红。
 * 可信与不可信用同一个夹具函数、只换来源种类，对照里保存与提交都真实走入口（不用内存对照）。
 */
describe('AC-TRF-65 ⑦ 保存值来源不可信：员工提交同值仍 403，单据不变', () => {
  /** 给草稿的职级追加一条来源行：`hr-input` 是不可信的人工来源，`system-input` 是可信的系统来源。 */
  async function levelOrigin(b: Awaited<ReturnType<typeof beta>>, originKind: 'hr-input' | 'system-input') {
    const { db } = database();
    await withTenant(db, b.s.w.tenant.id, async (tx) => {
      const [version] = resultRows<{ id: string; employeeId: string }>(
        await tx.execute(sql`
          SELECT id, employee_id AS "employeeId" FROM employment_payload_versions
          WHERE tenant_id=${b.s.w.tenant.id} AND business_id=${b.draft.id}::uuid ORDER BY version_no DESC LIMIT 1
        `),
      );
      await appendFieldOrigins(
        tx,
        { tenantId: b.s.w.tenant.id, userId: b.s.w.hr.id, now: new Date('2026-10-19T01:00:00.000Z') },
        [
          {
            businessId: b.draft.id,
            payloadVersionId: version!.id,
            employeeId: version!.employeeId,
            fieldCode: 'preset:levelId',
            originKind,
            value: b.base.level,
          },
        ],
      );
    });
  }

  it('对照：职级保存值来源是可信的系统来源时，同一份带同值职级的保存与提交都是 200', async () => {
    const b = await beta('f036s4-65-7-control');
    await levelOrigin(b, 'system-input');
    await ok(await b.s.patch(b.person, b.draft.id, { fields: { levelId: b.base.level }, effectiveDate: LATER }));
    await ok(await b.s.submit(b.person, b.draft.id));
    expect((await b.s.show(b.draft.id)).status).not.toBe('draft');
  });

  it('职级保存值来源是 hr-input：带同值职级保存与提交都 403，载荷版本与来源行都不变', async () => {
    const b = await beta('f036s4-65-7-untrusted');
    await levelOrigin(b, 'hr-input');
    const before = await snapshot(b.s, b.draft.id);
    await forbidden(await b.s.patch(b.person, b.draft.id, { fields: { levelId: b.base.level }, effectiveDate: LATER }));
    await forbidden(await b.s.submit(b.person, b.draft.id));
    expect(await snapshot(b.s, b.draft.id)).toEqual(before);
  });
});

describe('AC-TRF-65 ⑥ 提交接口带任职字段 → 400', () => {
  it.each(FOUR)('提交带 %s 报 400，单据不变', async (field) => {
    const b = await beta(`f036s4-65-6-${field}`);
    const before = await snapshot(b.s, b.draft.id);
    const response = await b.s.api.request('POST', `${BASE}/businesses/${b.draft.id}/submit`, {
      ...b.s.w.as(b.person.userId),
      ifMatch: before.counts.versions === 0 ? b.draft.revision : (await b.s.show(b.draft.id)).revision,
      body: { fields: { [field]: field === 'positionId' ? b.base.position : b.base.post } },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await snapshot(b.s, b.draft.id)).toEqual(before);
  });
});

/**
 * 员工行锁屏障（审查 P1-1）：甲（员工自填 P1 后收回职位编辑权，表单快照里职位仍可编辑）的草稿上，
 * 员工带 P1 的同值请求在事务外 / 命令守卫读到 P1 → 放行同值；排在员工行锁上等待期间，HR 把草稿职位改成 P2 并提交。
 * 员工请求带 HR 提交后的 revision，越过乐观锁进到锁内：此时 P1 对草稿已是新值，只能算本次输入。
 * `withEmployee = false` 是“只有 HR 改单”的对照：同一夹具、同一屏障，只是员工请求不发。
 */
async function raceAfterHr(label: string, withHr: boolean, withEmployee = true) {
  const a = await alpha(label);
  const { w } = a.s;
  const key = `k-${label}`;
  const revision = (await a.s.show(a.draft.id)).revision;
  const request = () =>
    a.s.patch(
      a.person,
      a.draft.id,
      { fields: { positionId: a.p1 }, effectiveDate: LATER },
      { revision: revision + (withHr ? 1 : 0), key },
    );
  const before = await snapshot(a.s, a.draft.id);
  const employeeRows = await a.s.originKinds(a.draft.id, 'preset:positionId');
  const [hr, employee] = await withTenant(w.db, w.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${w.tenant.id} AND id=${a.person.employeeId}::uuid FOR UPDATE`);
    const hrResponse = withHr ? a.s.hrEditDraft(a.draft.id, { positionId: a.p2 }, revision) : undefined;
    if (hrResponse) await waitForLockWaiters(w.db, 1);
    const employeeResponse = withEmployee ? request() : undefined;
    if (employeeResponse) await waitForLockWaiters(w.db, withHr ? 2 : 1);
    return [hrResponse, employeeResponse] as const;
  });
  const settled = { hr: hr && (await hr), employee: employee && (await employee) };
  const delta = await countsDelta(a.s, a.draft.id, before.counts);
  return { a, before, employeeRows, ...settled, request, key, delta };
}

/** 与 `before` 相比，载荷版本数、来源表全部行数、非继承来源行数各增加了多少。 */
async function countsDelta(s: SelfWorld, id: string, before: Awaited<ReturnType<SelfWorld['counts']>>) {
  const after = await s.counts(id);
  return {
    versions: after.versions - before.versions,
    origins: after.origins - before.origins,
    manual: after.manual - before.manual,
  };
}

/**
 * 重放屏障（第 3 轮 P2-1）：员工用职位 P1 成功执行命令 K0 → 租户收回职位编辑权 → 员工重放 K0 的同时 HR 把职位改成 P2。
 * 重放的授权判定必须在员工行锁内、按重放当刻的草稿重做：HR 先排到锁上，重放排在后面，进锁后 P1 已是新值（本次输入）→ 403。
 * `kind = 'recheck'`：重放的命令主事务先“并发冲突”失败，走失败后回查出口——它同样不得拿缓存的 200 交出去。
 */
async function replayRace(label: string, kind: 'direct' | 'recheck', withHr: boolean, withReplay = true) {
  const a = await alpha(label);
  const { w } = a.s;
  const revision = (await a.s.show(a.draft.id)).revision;
  const before = await snapshot(a.s, a.draft.id);
  let replayDone = false;
  const [hr, replay] = await withTenant(w.db, w.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${w.tenant.id} AND id=${a.person.employeeId}::uuid FOR UPDATE`);
    const hrResponse = withHr ? a.s.hrEditDraft(a.draft.id, { positionId: a.p2 }, revision) : undefined;
    if (hrResponse) await waitForLockWaiters(w.db, 1);
    if (kind === 'recheck' && withReplay) hooks.failMainTransaction = true;
    const replayResponse = withReplay ? a.s.patch(a.person, a.draft.id, a.k0.body, a.k0) : undefined;
    void replayResponse?.finally(() => (replayDone = true));
    // 已修复的实现里重放会排到锁上；未修复时它不等锁、直接返回，这时由断言判它的结果。
    if (replayResponse) await waitForLockWaiters(w.db, (withHr ? 1 : 0) + 1, () => replayDone);
    return [hrResponse, replayResponse] as const;
  });
  hooks.failMainTransaction = false;
  const settled = { hr: hr && (await hr), replay: replay && (await replay) };
  return { a, before, ...settled, delta: await countsDelta(a.s, a.draft.id, before.counts) };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-TRF-65 ⑧ 同值判定与写权校验绑定锁内同一份载荷（真 PG）',
  () => {
    it('同值请求等锁期间 HR 把草稿职位改成 P2：锁内它已是职位输入，员工无职位编辑权 → 403，载荷与来源都不写', async () => {
      const r = await raceAfterHr('f036s4-65-8-race', true);
      expect(r.hr!.status, await r.hr!.clone().text()).toBe(200);
      expect(r.employee!.status, await r.employee!.clone().text()).toBe(403);
      const after = await snapshot(r.a.s, r.a.draft.id);
      // 草稿只剩 HR 写入的 P2：员工的同值请求没有把职位写回 P1，也没有追加职位来源行，生效日期也没动。
      expect(after.fields).toMatchObject({ positionId: r.a.p2 });
      expect(after.origins.positionId?.value).toBe(r.a.p2);
      expect(await r.a.s.originKinds(r.a.draft.id, 'preset:positionId')).toHaveLength(r.employeeRows.length + 1);
      expect(after.effectiveDate).toBe(r.before.effectiveDate);
      // 全量增量（载荷版本、全部来源行）与“只有 HR 改单”的对照完全一致：被拒的员工请求一行都没多写。
      const control = await raceAfterHr('f036s4-65-8-hr-only', true, false);
      expect(control.delta.versions).toBeGreaterThan(0);
      expect(r.delta).toEqual(control.delta);
    });

    it('对照：没有 HR 改动时同一个同值请求仍是 200，同键重放返回首次结果且不追加行', async () => {
      const r = await raceAfterHr('f036s4-65-8-control', false);
      expect(r.employee!.status, await r.employee!.clone().text()).toBe(200);
      const first = await r.employee!.json();
      const after = await snapshot(r.a.s, r.a.draft.id);
      expect(after.effectiveDate).toBe(LATER);
      expect(after.origins.positionId).toEqual(r.before.origins.positionId);
      const replay = await ok(await r.request());
      expect(await replay.json()).toEqual(first);
      expect(await snapshot(r.a.s, r.a.draft.id)).toEqual(after);
    });

    describe.each(['direct', 'recheck'] as const)('⑨ 缓存命中的同键重放按锁内当刻判（%s）', (kind) => {
      it('K0 当时通过，收回职位编辑权后重放等锁期间 HR 把职位改成 P2：重放 403，零写入，不返回缓存', async () => {
        const r = await replayRace(`f036s4-65-9-${kind}`, kind, true);
        expect(r.hr!.status, await r.hr!.clone().text()).toBe(200);
        expect(r.replay!.status, await r.replay!.clone().text()).toBe(403);
        const after = await snapshot(r.a.s, r.a.draft.id);
        expect(after.fields).toMatchObject({ positionId: r.a.p2 });
        // 与只有 HR 改单的对照比全部载荷版本与来源行：被拒的重放没有写任何东西。
        const control = await replayRace(`f036s4-65-9-${kind}-hr-only`, kind, true, false);
        expect(control.delta.versions).toBeGreaterThan(0);
        expect(r.delta).toEqual(control.delta);
      });

      it('对照：职位没变时合法重放仍是 200，返回首次结果，单据与行数不变', async () => {
        const r = await replayRace(`f036s4-65-9-${kind}-ok`, kind, false);
        expect(r.replay!.status, await r.replay!.clone().text()).toBe(200);
        expect(await r.replay!.json()).toEqual(r.a.firstBody);
        expect(await snapshot(r.a.s, r.a.draft.id)).toEqual(r.before);
        expect(r.delta).toEqual({ versions: 0, origins: 0, manual: 0 });
      });
    });
  },
);

/**
 * 范围收回屏障（第 4 轮 P2）：部门范围 HR 首次合法 PATCH（命令 K0）成功 → 同键重放进入守卫、排在员工行锁上等待
 * → 等锁期间管理员收回该部门范围（对象、按钮、字段权限仍在）→ 放锁。重放的数据范围必须在锁内解析：
 * 收回后要被拒（范围外与不存在同一个 404），不得拿等锁前的旧范围返回 200 与原回执。
 * `kind = 'recheck'`：重放的命令主事务先“并发冲突”失败，走失败后回查出口，同样不得沿用旧范围。
 * `revoke = false` 是“范围没变”的对照：同一夹具、同一屏障，只是不收回。
 */
async function scopeRevokeRace(label: string, kind: 'direct' | 'recheck', revoke: boolean) {
  const b = await beta(label);
  const { w } = b.s;
  const hr = await scopedHr(b.s);
  const k0 = { revision: (await b.s.show(b.draft.id)).revision, key: `k0-${label}` };
  const body = { effectiveDate: LATER };
  const first = await ok(await b.s.patch(hr, b.draft.id, body, k0));
  const firstBody = await first.json();
  const before = await snapshot(b.s, b.draft.id);
  let replayDone = false;
  const replay = await withTenant(w.db, w.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${w.tenant.id} AND id=${b.person.employeeId}::uuid FOR UPDATE`);
    if (kind === 'recheck') hooks.failMainTransaction = true;
    const response = b.s.patch(hr, b.draft.id, body, k0);
    void response.finally(() => (replayDone = true));
    // 未修复时重放在等锁前就解析了范围，已修复时它排到锁上；任何一种都在它还没返回时收回范围。
    await waitForLockWaiters(w.db, 1, () => replayDone);
    if (revoke) await hr.revokeScope();
    // 返回数组而不是 Promise 本身：异步函数会等 Promise 落定，那样放锁的事务提交要等重放，重放要等锁，就死锁了。
    return [response] as const;
  });
  hooks.failMainTransaction = false;
  return { b, hr, firstBody, before, replay: await replay[0] };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF-65 ⑩ 同单重放的数据范围在员工锁内解析（真 PG）', () => {
  describe.each(['direct', 'recheck'] as const)('缓存命中的同键重放（%s）', (kind) => {
    it('部门范围 HR 的重放等锁期间范围被收回（对象、按钮、字段权限仍在）：404，零写入，不返回原回执', async () => {
      const r = await scopeRevokeRace(`f036s4-65-10-${kind}`, kind, true);
      expect(r.replay.status, await r.replay.clone().text()).toBe(404);
      expect(JSON.stringify(await r.replay.json())).not.toContain(String(r.firstBody.id));
      // 被拒的重放没有写任何东西：载荷版本、来源行、字段值与四个字段的来源都与首次执行之后一致。
      expect(await snapshot(r.b.s, r.b.draft.id)).toEqual(r.before);
    });

    it('对照：范围没变时合法重放仍是 200，返回首次回执，单据与行数不变', async () => {
      const r = await scopeRevokeRace(`f036s4-65-10-${kind}-ok`, kind, false);
      expect(r.replay.status, await r.replay.clone().text()).toBe(200);
      expect(await r.replay.json()).toEqual(r.firstBody);
      expect(await snapshot(r.b.s, r.b.draft.id)).toEqual(r.before);
    });
  });
});
