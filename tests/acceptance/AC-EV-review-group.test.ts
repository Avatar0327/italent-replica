/**
 * R3-T02 PR-B B3：评审组（`TEvaluation.ReviewGroup`）+ 人员引用出口（设计 §3.2、§5.1、§8、§9；拆分方案第 4 节 B3 行）。真实授权器：
 * - 评审组：所属组织必填手选且须在操作人范围内（DEC-082 / DEC-324②），列表 / 详情按所属组织裁剪（分页前）；成员整组编辑，
 *   恰好 1 个组长；编码租户内唯一；并发与幂等（DEC-067）；
 * - 设计 §9 “DEC-331① / DEC-339②”整行：管理员人员范围只含 E1，成员 E1、E2、E3：详情三人都有 ID 与姓名、E2 / E3 没有
 *   工号等其他字段、成员数 3；E2 的 ID 查人员详情 404（与不存在的 ID 同一响应）；原样提交完整集合 200、成员不变；
 *   新增范围外员工 404、成员不变；删除范围外成员允许；所属组织在范围外的评审组不出现、详情 404；
 * - 字段权与显式清空；成员候选只在人员范围内；首次与重放都按当前范围复核；审计前后值呈现。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { errorOf, EV_BASE, EV_NOW, ok } from './AC-EV-support.js';
import {
  CANDIDATES,
  type Employee,
  GROUPS,
  type GroupView,
  type MemberView,
  type ReviewOperator,
  reviewOperator,
  type ReviewOperatorOptions,
  reviewWorld,
  type ReviewWorld,
} from './AC-EV-review-support.js';

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);
const code = () => `RG${suffix()}`;
const ids = (members: readonly MemberView[]) => members.map((member) => member.employeeId);

interface Page {
  readonly hasDataPermission: boolean;
  readonly items: GroupView[];
}
interface CandidatePage {
  readonly items: { id: string; name?: string; code?: string }[];
}

describe('AC-EV-review-group 评审组', () => {
  let w: ReviewWorld;
  let e1: Employee; // 甲部
  let e2: Employee; // 乙部
  let e3: Employee; // 乙部
  let e4: Employee; // 丙部
  beforeAll(async () => {
    w = await reviewWorld(testDb().db);
    e1 = await w.hire('评委甲一', w.orgA);
    e2 = await w.hire('评委乙二', w.orgB);
    e3 = await w.hire('评委乙三', w.orgB);
    e4 = await w.hire('评委丙四', w.orgC);
  });

  const members = (...list: [Employee, boolean?][]) =>
    list.map(([employee, leader], index) => ({ employeeId: employee.id, isLeader: leader ?? index === 0 }));
  const body = (extra: Record<string, unknown> = {}) => ({
    code: code(),
    name: `评审组${suffix()}`,
    ownerOrgId: w.orgA,
    members: members([e1]),
    ...extra,
  });
  /** 评审组管理员：评审组范围 = 甲部，员工信息范围 = 只含甲部（所以只有 E1 在人员范围内）。 */
  const manager = (options: ReviewOperatorOptions = {}) =>
    reviewOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA], ...options });
  const post = (op: ReviewOperator, data: Record<string, unknown>, extra = {}) =>
    op.request('POST', GROUPS, { ifMatch: 0, body: data, ...extra });
  const created = (op: ReviewOperator, data: Record<string, unknown> = body()) =>
    post(op, data).then((r) => ok<GroupView>(r, 201));
  const patch = (op: ReviewOperator, group: GroupView, data: Record<string, unknown>, extra = {}) =>
    op.request('PATCH', `${GROUPS}/${group.id}`, { ifMatch: group.revision, body: data, ...extra });
  const read = (op: ReviewOperator, id: string) => op.request('GET', `${GROUPS}/${id}`);
  const adminReads = async (id: string) =>
    ok<GroupView>(await w.setup.request('GET', `${EV_BASE}${GROUPS}/${id}`, w.asAdmin));

  describe('CRUD 与成员整组编辑', () => {
    it('新建 / 详情 / 修改名称与成员 / 删除；成员按提交顺序，组长恰好 1 个', async () => {
      const op = await manager();
      const group = await created(op, body({ members: members([e1, true]) }));
      expect(group).toMatchObject({ revision: 1, enabled: true, ownerOrgId: w.orgA, createdBy: op.userId });
      expect(group.members).toEqual([expect.objectContaining({ employeeId: e1.id, isLeader: true, name: e1.name })]);
      expect(await ok<GroupView>(await read(op, group.id))).toEqual(group);

      const renamed = await ok<GroupView>(await patch(op, group, { name: `改名${suffix()}` }));
      expect(renamed).toMatchObject({ revision: 2 });
      expect(ids(renamed.members)).toEqual([e1.id]);

      // 只改成员也推进 revision，成员整组替换
      const swapped = await ok<GroupView>(await patch(op, renamed, { members: members([e1, true]) }));
      expect(swapped.members).toHaveLength(1);
      expect(swapped.revision).toBe(3);
    });

    it('组长个数：没有组长、两个组长、成员为空、成员重复、编码 / 名称 / 成员数结构非法都是 400，数据不变', async () => {
      const op = await manager({ personOrgs: [w.orgA, w.orgB, w.orgC] });
      const group = await created(op, body({ members: members([e1, true], [e2, false]) }));
      const cases: [string, Record<string, unknown>][] = [
        ['无组长', { members: members([e1, false], [e2, false]) }],
        ['两个组长', { members: members([e1, true], [e2, true]) }],
        ['成员为空', { members: [] }],
        ['成员重复', { members: members([e1, true], [e1, false]) }],
        ['非法键', { members: [{ employeeId: e1.id, isLeader: true, name: '多余' }] }],
      ];
      for (const [label, data] of cases) {
        const create = await post(op, body(data));
        expect(create.status, label).toBe(400);
        const update = await patch(op, group, data);
        expect(update.status, label).toBe(400);
      }
      const leaderError = await post(op, body({ members: members([e1, false]) }));
      expect((await errorOf(leaderError)).reason).toBe('REVIEW_GROUP_LEADER_REQUIRED');
      const duplicate = await post(op, body({ members: members([e1, true], [e1, false]) }));
      expect((await errorOf(duplicate)).reason).toBe('REVIEW_GROUP_MEMBER_DUPLICATE');
      for (const bad of [
        { code: '' },
        { code: '含 空格' },
        { name: '' },
        { name: 'x'.repeat(101) },
        { ownerId: op.userId },
      ]) {
        expect((await post(op, body(bad))).status, JSON.stringify(bad)).toBe(400);
      }
      const tooMany = Array.from({ length: 201 }, () => ({ employeeId: randomUUID(), isLeader: false }));
      expect((await post(op, body({ members: tooMany }))).status).toBe(400);
      expect(await ok<GroupView>(await read(op, group.id))).toEqual(group);
    });

    it('编码租户内唯一：重复 409 DUPLICATE，并发创建同编码只成功一条', async () => {
      const op = await manager();
      const first = await created(op);
      const duplicate = await post(op, body({ code: first.code }));
      expect(duplicate.status).toBe(409);
      expect((await errorOf(duplicate)).reason).toBe('DUPLICATE');
      const other = await created(op);
      const clash = await patch(op, other, { code: first.code });
      expect(clash.status).toBe(409);
      expect(await ok<GroupView>(await read(op, other.id))).toEqual(other);
      const sameCode = code();
      const results = await Promise.all([post(op, body({ code: sameCode })), post(op, body({ code: sameCode }))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('并发与幂等：缺 If-Match 400、过期 409 且数据不变、同键同内容重放不重复写、同键异内容 409', async () => {
      const op = await manager();
      const group = await created(op);
      const missing = await op.request('PATCH', `${GROUPS}/${group.id}`, { body: { name: 'x' } });
      expect(missing.status).toBe(400);
      const stale = await patch(op, { ...group, revision: 9 }, { name: 'y' });
      expect(stale.status).toBe(409);
      expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
      const key = randomUUID();
      const data = body();
      const first = await ok<GroupView>(await post(op, data, { idempotencyKey: key }), 201);
      const replay = await ok<GroupView>(await post(op, data, { idempotencyKey: key }), 201);
      expect(replay).toEqual(first);
      const mismatch = await post(op, body(), { idempotencyKey: key });
      expect(mismatch.status).toBe(409);
      expect((await errorOf(mismatch)).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await ok<GroupView>(await read(op, group.id))).toEqual(group);
    });
  });

  describe('所属组织：必填手选，须在操作人范围内；列表 / 详情按所属组织裁剪（分页前）', () => {
    it('缺所属组织 400；范围外组织与不存在的组织同为 404；改所属组织到范围外 404，数据不变', async () => {
      const op = await manager();
      const { ownerOrgId: _omit, ...withoutOrg } = body();
      expect((await post(op, withoutOrg)).status).toBe(400);
      const outside = await post(op, body({ ownerOrgId: w.orgB }));
      const missing = await post(op, body({ ownerOrgId: randomUUID() }));
      expect(outside.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await outside.json()).toEqual(await missing.json());
      const group = await created(op);
      expect((await patch(op, group, { ownerOrgId: w.orgB })).status).toBe(404);
      expect((await adminReads(group.id)).ownerOrgId).toBe(w.orgA);
    });

    it('所属组织在范围外的评审组：不出现在列表、详情 / 修改 / 删除 404；空范围列表为空且 hasDataPermission=false', async () => {
      const outsideGroup = await w.adminGroup(body({ ownerOrgId: w.orgB, members: members([e2]) }));
      const insideGroup = await w.adminGroup(body({ ownerOrgId: w.orgA }));
      const op = await manager();
      const page = await ok<Page>(await op.request('GET', `${GROUPS}?pageSize=100`));
      const listed = page.items.map((item) => item.id);
      expect(listed).toContain(insideGroup.id);
      expect(listed).not.toContain(outsideGroup.id);
      expect((await read(op, outsideGroup.id)).status).toBe(404);
      expect((await patch(op, outsideGroup, { name: 'x' })).status).toBe(404);
      expect(
        (await op.request('DELETE', `${GROUPS}/${outsideGroup.id}`, { ifMatch: outsideGroup.revision })).status,
      ).toBe(404);
      expect(await adminReads(outsideGroup.id)).toMatchObject({ id: outsideGroup.id, revision: outsideGroup.revision });

      const empty = await reviewOperator(w, { personOrgs: [w.orgA] });
      expect(await ok<Page>(await empty.request('GET', GROUPS))).toMatchObject({ items: [], hasDataPermission: false });
      expect((await read(empty, insideGroup.id)).status).toBe(404);
      expect((await post(empty, body())).status).toBe(404);
    });

    it('分页在范围裁剪之后：范围外的组不占页、不计入', async () => {
      for (let i = 0; i < 3; i++) await w.adminGroup(body({ ownerOrgId: w.orgB, members: members([e2]) }));
      const mine = await w.adminGroup(body({ ownerOrgId: w.orgC, name: `分页${suffix()}` }));
      const op = await reviewOperator(w, { evOrgs: [w.orgC], personOrgs: [w.orgA] });
      const page = await ok<Page>(await op.request('GET', `${GROUPS}?pageSize=1`));
      expect(page.items.map((item) => item.id)).toEqual([mine.id]);
    });
  });

  describe('人员引用出口（设计 §9 DEC-331① / DEC-339②）', () => {
    /** 管理员建的评审组：成员 E1（人员范围内）、E2、E3（范围外）；被测操作人评审组范围 = 甲部、人员范围 = 甲部。 */
    const fixture = async () => {
      const group = await w.adminGroup(body({ members: members([e1, true], [e2, false], [e3, false]) }));
      return { group, op: await manager() };
    };

    it('详情三人都有 ID 与姓名、成员数 3；E2 / E3 没有工号等其他字段；范围内成员带工号', async () => {
      const { group, op } = await fixture();
      const detail = await ok<GroupView>(await read(op, group.id));
      expect(detail.members).toHaveLength(3);
      const byId = new Map(detail.members.map((member) => [member.employeeId, member]));
      expect(byId.get(e1.id)).toEqual({ employeeId: e1.id, isLeader: true, name: e1.name, code: e1.code });
      expect(byId.get(e2.id)).toEqual({ employeeId: e2.id, isLeader: false, name: e2.name });
      expect(byId.get(e3.id)).toEqual({ employeeId: e3.id, isLeader: false, name: e3.name });
      const listed = (await ok<Page>(await op.request('GET', `${GROUPS}?pageSize=100`))).items.find(
        (i) => i.id === group.id,
      )!;
      expect(listed.members).toEqual(detail.members);
    });

    it('拿 E2 的 ID 查人员详情 → 404，与不存在的 ID 响应相同', async () => {
      const { op } = await fixture();
      expect((await op.request('GET', `/api/tenant/personnel/employees/${e1.id}`)).status).toBe(200);
      const outside = await op.request('GET', `/api/tenant/personnel/employees/${e2.id}`);
      const missing = await op.request('GET', `/api/tenant/personnel/employees/${randomUUID()}`);
      expect(outside.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await outside.json()).toEqual(await missing.json());
    });

    it('原样提交完整集合 → 200、成员不变（范围外成员原样保留）；新增范围外员工 → 404、成员不变；删除范围外成员允许', async () => {
      const { group, op } = await fixture();
      const same = await ok<GroupView>(
        await patch(op, group, { members: members([e1, true], [e2, false], [e3, false]) }),
      );
      expect(ids(same.members)).toEqual([e1.id, e2.id, e3.id]);
      const add = await patch(op, same, { members: members([e1, true], [e2, false], [e3, false], [e4, false]) });
      expect(add.status).toBe(404);
      const missing = await patch(op, same, {
        members: members([e1, true], [e2, false], [e3, false]).concat([{ employeeId: randomUUID(), isLeader: false }]),
      });
      expect(missing.status).toBe(404);
      expect(await add.json()).toEqual(await missing.json());
      expect(ids((await adminReads(group.id)).members)).toEqual([e1.id, e2.id, e3.id]);
      const removed = await ok<GroupView>(await patch(op, same, { members: members([e1, true], [e3, false]) }));
      expect(ids(removed.members)).toEqual([e1.id, e3.id]);
      expect(removed.members).toHaveLength(2);
    });

    it('组长是范围外成员也可以：原样保留；新建时直接指定范围外员工当成员 404', async () => {
      const group = await w.adminGroup(body({ members: members([e2, true], [e1, false]) }));
      const op = await manager();
      const detail = await ok<GroupView>(await read(op, group.id));
      expect(detail.members[0]).toEqual({ employeeId: e2.id, isLeader: true, name: e2.name });
      const same = await ok<GroupView>(
        await patch(op, detail, { name: `改${suffix()}`, members: members([e2, true], [e1, false]) }),
      );
      expect(ids(same.members)).toEqual([e2.id, e1.id]);
      expect((await post(op, body({ members: members([e2, true]) }))).status).toBe(404);
    });

    it('员工信息字段权：看不到姓名时范围内外成员都只有 ID；没有员工信息对象权时不能新增成员（403），原有成员只给 ID', async () => {
      const group = await w.adminGroup(body({ members: members([e1, true], [e2, false]) }));
      const noName = await manager({ hiddenEmployeeFields: ['name'] });
      const detail = await ok<GroupView>(await read(noName, group.id));
      for (const member of detail.members)
        expect(Object.keys(member).sort()).toEqual(
          ['employeeId', 'isLeader'].concat(member.employeeId === e1.id ? ['code'] : []).sort(),
        );
      const noObject = await manager({ noEmployeeObject: true });
      const bare = await ok<GroupView>(await read(noObject, group.id));
      for (const member of bare.members) expect(Object.keys(member).sort()).toEqual(['employeeId', 'isLeader']);
      const same = await patch(noObject, group, { members: members([e1, true], [e2, false]) });
      expect(same.status).toBe(200); // 没有新增 ID：原样提交完整集合
      const fresh = await created(await manager(), body());
      const added = await patch(noObject, fresh, { members: members([e1, true], [e4, false]) });
      expect(added.status).toBe(403);
    });
  });

  describe('成员候选：统一人员范围（分页前）', () => {
    it('只列人员范围内的员工；按工号 / 姓名搜索；范围外员工不出现、不计数', async () => {
      const op = await manager();
      const page = await ok<CandidatePage>(await op.request('GET', `${CANDIDATES}?pageSize=100`));
      const found = page.items.map((item) => item.id);
      expect(found).toContain(e1.id);
      expect(found).not.toContain(e2.id);
      expect(found).not.toContain(e3.id);
      const byName = await ok<CandidatePage>(
        await op.request('GET', `${CANDIDATES}?keyword=${encodeURIComponent('评委甲一')}`),
      );
      expect(byName.items).toEqual([{ id: e1.id, name: e1.name, code: e1.code }]);
      const outside = await ok<CandidatePage>(
        await op.request('GET', `${CANDIDATES}?keyword=${encodeURIComponent('评委乙二')}`),
      );
      expect(outside.items).toEqual([]);
      const first = await ok<CandidatePage>(await op.request('GET', `${CANDIDATES}?pageSize=1`));
      expect(first.items).toHaveLength(1);
    });

    it('没有员工信息查看权 403；看不到姓名 / 工号字段时搜索它们 403 FILTER_FIELD_HIDDEN，列表只带可见字段', async () => {
      const none = await manager({ noEmployeeObject: true });
      expect((await none.request('GET', CANDIDATES)).status).toBe(403);
      const noName = await manager({ hiddenEmployeeFields: ['name'] });
      const blind = await noName.request('GET', `${CANDIDATES}?keyword=${encodeURIComponent('评委甲')}`);
      expect(blind.status).toBe(200); // 工号仍可见：只按工号匹配，姓名不参与
      expect((await ok<CandidatePage>(blind)).items).toEqual([]);
      const byCode = await ok<CandidatePage>(await noName.request('GET', `${CANDIDATES}?keyword=${e1.code}`));
      expect(byCode.items).toEqual([{ id: e1.id, code: e1.code }]);
      const neither = await manager({ hiddenEmployeeFields: ['name', 'code'] });
      const denied = await neither.request('GET', `${CANDIDATES}?keyword=x`);
      expect(denied.status).toBe(403);
      expect(await errorOf(denied)).toEqual({ code: 'FORBIDDEN', reason: 'FILTER_FIELD_HIDDEN' });
      const plain = await ok<CandidatePage>(await neither.request('GET', CANDIDATES));
      for (const item of plain.items) expect(Object.keys(item)).toEqual(['id']);
    });
  });

  describe('权限：数据操作、按钮、字段（含显式清空）', () => {
    it('没有新建 / 编辑 / 删除数据操作权各 403，没有按钮 403，查看照常，数据不变', async () => {
      const group = await w.adminGroup(body());
      expect((await post(await manager({ noCreate: true }), body())).status).toBe(403);
      expect((await patch(await manager({ noUpdate: true }), group, { name: 'x' })).status).toBe(403);
      const noDelete = await manager({ noDelete: true });
      expect((await noDelete.request('DELETE', `${GROUPS}/${group.id}`, { ifMatch: group.revision })).status).toBe(403);
      const noButtons = await manager({ noButtons: true });
      expect((await post(noButtons, body())).status).toBe(403);
      expect((await patch(noButtons, group, { name: 'x' })).status).toBe(403);
      expect((await read(noButtons, group.id)).status).toBe(200);
      expect(await adminReads(group.id)).toMatchObject({ id: group.id, revision: group.revision });
    });

    it('成员字段看不到：列表 / 详情 / 写入响应都不带成员；成员字段只读：改成员 403，改名照常；所属组织字段只读：改所属组织 403', async () => {
      const group = await w.adminGroup(body({ members: members([e1, true], [e2, false]) }));
      const hidden = await manager({ hidden: ['members'] });
      expect(await ok<GroupView>(await read(hidden, group.id))).not.toHaveProperty('members');
      const page = await ok<Page>(await hidden.request('GET', `${GROUPS}?pageSize=100`));
      for (const item of page.items) expect(item).not.toHaveProperty('members');
      // 成员字段不可见也就不可编辑：新建必须带成员，所以 403
      expect((await post(hidden, body())).status).toBe(403);
      const renamedHidden = await ok<GroupView>(await patch(hidden, group, { name: `隐藏成员改名${suffix()}` }));
      expect(renamedHidden).not.toHaveProperty('members');
      const readonly = await manager({ readonly: ['members', 'ownerOrgId'] });
      const current = { ...group, revision: renamedHidden.revision };
      expect((await patch(readonly, current, { members: members([e1, true]) })).status).toBe(403);
      expect((await patch(readonly, current, { ownerOrgId: w.orgA })).status).toBe(403);
      expect(await ok<GroupView>(await patch(readonly, current, { name: `可改${suffix()}` }))).toMatchObject({
        revision: current.revision + 1,
      });
    });

    it('筛选与排序不泄露：没有 enabled 查看权时 ?enabled= 是 403 FILTER_FIELD_HIDDEN；没有名称 / 编码查看权时只按主键排序', async () => {
      await w.adminGroup(body());
      const blind = await manager({ hidden: ['enabled'] });
      for (const value of ['true', 'false']) {
        const response = await blind.request('GET', `${GROUPS}?enabled=${value}`);
        expect(response.status, value).toBe(403);
        expect(await errorOf(response)).toEqual({ code: 'FORBIDDEN', reason: 'FILTER_FIELD_HIDDEN' });
      }
      const keyed = await manager({ hidden: ['name', 'code'] });
      const listed = (await ok<Page>(await keyed.request('GET', `${GROUPS}?pageSize=100`))).items.map(
        (item) => item.id,
      );
      expect(listed.length).toBeGreaterThan(1);
      expect(listed).toEqual([...listed].sort());
    });
  });

  describe('首次与重放都按当前范围复核', () => {
    it('新建后评审组范围被撤销：同键重放 404；人员范围变化：重放响应按当前人员范围重新呈现成员', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body({ members: members([e1, true]) });
      const first = await ok<GroupView>(await post(op, data, { idempotencyKey: key }), 201);
      expect(first.members[0]).toMatchObject({ code: e1.code });
      await op.setPersonOrgs([w.orgB]);
      const shifted = await ok<GroupView>(await post(op, data, { idempotencyKey: key }), 201);
      expect(shifted.id).toBe(first.id);
      expect(shifted.members[0]).toEqual({ employeeId: e1.id, isLeader: true, name: e1.name });
      await op.setEvOrgs(undefined);
      expect((await post(op, data, { idempotencyKey: key })).status).toBe(404);
      await op.setEvOrgs([w.orgA]);
      await op.setPersonOrgs([w.orgA]);
    });

    it('删除重放：撤销范围后按快照的所属组织复核，范围内照常返回、范围外 404', async () => {
      const op = await manager();
      const group = await created(op);
      const key = randomUUID();
      await ok(await op.request('DELETE', `${GROUPS}/${group.id}`, { ifMatch: group.revision, idempotencyKey: key }));
      const replay = await op.request('DELETE', `${GROUPS}/${group.id}`, {
        ifMatch: group.revision,
        idempotencyKey: key,
      });
      expect(replay.status).toBe(200);
      await op.setEvOrgs([w.orgC]);
      const denied = await op.request('DELETE', `${GROUPS}/${group.id}`, {
        ifMatch: group.revision,
        idempotencyKey: key,
      });
      expect(denied.status).toBe(404);
      await op.setEvOrgs([w.orgA]);
    });
  });

  describe('审计（DEC-019 / 216：业务写与审计同事务；前后值呈现成员）', () => {
    it('新建 / 修改 / 删除各一条，动作 evaluation.review-group.*；成员前后值只含员工 ID、当时姓名与组长标记，范围外成员同口径', async () => {
      const op = await manager({ auditor: true, personOrgs: [w.orgA, w.orgB, w.orgC] });
      const group = await created(op, body({ members: members([e1, true]) }));
      const widened = await ok<GroupView>(
        await patch(op, group, { members: members([e1, true], [e2, false]), name: `新名${suffix()}` }),
      );
      await ok(await op.request('DELETE', `${GROUPS}/${widened.id}`, { ifMatch: widened.revision }));
      const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
      const logs = (
        await audit.dataChanges(op.as, { objectType: 'TEvaluation.ReviewGroup', limit: '100' })
      ).items.filter((item) => item.objectId === group.id);
      expect(logs.map((item) => item.action).sort()).toEqual([
        'evaluation.review-group.create',
        'evaluation.review-group.delete',
        'evaluation.review-group.update',
      ]);
      const detail = (action: string) => audit.dataChange(op.as, logs.find((item) => item.action.endsWith(action))!.id);
      const first = await detail('.create');
      expect(first.after).toMatchObject({
        members: [{ employeeId: e1.id, employeeName: e1.name, isLeader: true }],
      });
      const update = await detail('.update');
      expect(update.after).toMatchObject({
        members: [
          { employeeId: e1.id, employeeName: e1.name, isLeader: true },
          { employeeId: e2.id, employeeName: e2.name, isLeader: false },
        ],
      });
      expect(update.changes.map((change) => change.field)).toEqual(expect.arrayContaining(['members', 'name']));
      // 成员条目只有这三个键：不带工号、邮箱等其他字段
      for (const member of (update.after as { members: object[] }).members) {
        expect(Object.keys(member).sort()).toEqual(['employeeId', 'employeeName', 'isLeader']);
      }
      expect((await detail('.delete')).before).toMatchObject({ id: group.id });
    });
  });
});
