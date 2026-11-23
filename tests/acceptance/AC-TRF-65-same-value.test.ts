/**
 * AC-TRF-65（F-036-S4）：员工草稿上职位、职务、职级、序列的“同值放行”与可信来源判断（DEC-950）。
 * 设计：docs/08_设计/F-036_字段来源记录与迟到后重建_设计.md §4.6、§5.2、§7.1、§10.1。
 * 夹具：甲＝DEC-950 原例；乙＝继承四字段；乙′＝原任职没有职位；丙＝HR 改当前任职后向后更新传播。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE, FOUR, LATER, ok, selfWorld, type Fields, type Four, type SelfWorld } from './AC-TRF-F036S4-support.js';

const database = useTestDb();
const NEXT_DATE = '2026-11-02';

/** 草稿当前状态：行数、字段值、生效日、四个字段的最后写入来源；“不变 / 零写入”都拿它比。 */
async function snapshot(s: SelfWorld, id: string) {
  const shown = await s.show(id);
  const origins = {} as Record<Four, { value: unknown; kind: string | null }>;
  for (const field of FOUR) origins[field] = await s.origin(id, field);
  return { counts: await s.counts(id), fields: shown.fields, effectiveDate: shown.effectiveDate, origins };
}
const forbidden = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(403);
};

/** 乙／乙′：原任职有（无）职位的员工建同部门草稿，四个字段全部继承。 */
async function beta(label: string, withPosition = true) {
  const s = await selfWorld(database().db, label);
  const base = await s.catalog();
  const other = await s.catalog();
  const person = await s.employee('合成员工', {
    postId: base.post,
    sequenceId: base.sequence,
    levelId: base.level,
    ...(withPosition ? { positionId: base.position } : {}),
  });
  const draft = await s.draftOf(person);
  return { s, base, other, person, draft };
}

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
    expect(after.counts.origins).toBe(before.counts.origins);
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
    expect(after.counts.origins).toBe(before.counts.origins);
    expect(after.origins.positionId).toEqual({ value: a.p1, kind: 'employee-input' });

    const replay = await ok(await a.s.patch(a.person, a.draft.id, a.k0.body, a.k0));
    expect(await replay.json()).toEqual(a.firstBody);
    expect((await snapshot(a.s, a.draft.id)).counts.origins).toBe(before.counts.origins);
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
    expect(together.counts.origins).toBe(before.counts.origins);
    for (const field of FOUR) {
      await ok(await b.s.patch(b.person, b.draft.id, { fields: { [field]: same[field] }, effectiveDate: NEXT_DATE }));
      const one = await snapshot(b.s, b.draft.id);
      expect(one.origins, field).toEqual(before.origins);
      expect(one.fields, field).toEqual(before.fields);
      expect(one.counts.origins, field).toBe(before.counts.origins);
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
    expect(after.counts.origins).toBe(before.counts.origins);
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
    expect(after.counts.origins).toBe(before.counts.origins);
  });

  it('f. 乙只带同值职务：200，不是 400（扣空后无业务字段，按无变化整版重提）', async () => {
    const b = await beta('f036s4-65-2f');
    const before = await snapshot(b.s, b.draft.id);
    await ok(await b.s.patch(b.person, b.draft.id, { fields: { postId: b.base.post } }));
    const after = await snapshot(b.s, b.draft.id);
    expect(after.fields).toEqual(before.fields);
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.origins).toBe(before.counts.origins);
  });

  it('g. 乙′（原任职没有职位）带 positionId: null，200，不记显式清空', async () => {
    const b = await beta('f036s4-65-2g', false);
    const before = await snapshot(b.s, b.draft.id);
    await ok(await b.s.patch(b.person, b.draft.id, { fields: { positionId: null }, effectiveDate: LATER }));
    const after = await snapshot(b.s, b.draft.id);
    expect(after.effectiveDate).toBe(LATER);
    expect(after.fields).toEqual(before.fields);
    expect(after.origins).toEqual(before.origins);
    expect(after.counts.origins).toBe(before.counts.origins);
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
  it('新建与预览入口不做同值放行', async () => {
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
    for (const suffix of ['', '/preview'])
      for (const field of FOUR)
        for (const value of [same[field], null, same[field].toUpperCase()]) {
          const response = await b.s.api.request(
            'POST',
            `${BASE}/transfers/employees/${b.person.employeeId}${suffix}`,
            {
              ...b.s.w.as(b.person.userId),
              ifMatch: await revision(),
              body: {
                initiator: 'employee',
                transferTypeCode: 'in_department',
                formId: 'TenantBase.TransferMultiFormView',
                effectiveDate: LATER,
                mode: 'application',
                submit: false,
                fields: { departmentId: b.s.source, [field]: value },
              },
            },
          );
          const kind = value === null ? 'null' : value === same[field] ? 'same' : 'upper';
          seen.push(`${suffix || '/create'} ${field} ${kind} ${response.status}`);
        }
    // 预览里表单本就不开放职位编辑，校验先于权限判定回 400；仍是拒绝，不因同值放行。其余入口与字段都是 403。
    expect(seen.filter((line) => !line.endsWith(' 403'))).toEqual([
      '/preview positionId same 400',
      '/preview positionId null 400',
      '/preview positionId upper 400',
    ]);
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
