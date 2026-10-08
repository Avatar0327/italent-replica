/**
 * PR #107 第 5 轮修改清单（DEC-297③ / DEC-309②，评论 6055355463；依据第 4 轮审查 6052229506）的两项 P2：
 * - R4-P2-1 邮箱改归属后用原键、原载荷重放：新增评价对象、新增评价者、导入关系三个入口都不得返回范围外人员的历史
 *   结果——按历史回执里的稳定 ID（人员、评价者、评价关系）按当前权限复核，导入逐条复核实际的评价对象与评价者；
 *   不能只按当前邮箱持有人验权，也不能只裁字段。
 * - R4-P2-2 创建人范围（using_user）下回补：首人 EMAIL_TAKEN 后跟随返回的游标、limit=1 续页，第二人照常回补，
 *   游标不退回 backfill:（判定与筛选回补目标同一口径：实际 360 人员及创建人）。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  fullAccess,
  type ObjectView,
  type PersonView,
  type RelationView,
  world360,
  type World360,
} from './AC-360-support.js';

const testDb = useTestDb();
const APP = survey360.SURVEY360_APP;
const PERSON = survey360.SURVEY360_OBJECTS.person.code;

interface SyncPage {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  skipped: { employeeId: string; reason: string }[];
  nextCursor: string | null;
}

async function hire(w: World360, employee: { id: string; revision: number }, orgId: string, managerId?: string) {
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
}

/**
 * 组织员工侧改工作邮箱（同步取邮箱先取工作邮箱）；返回员工信息的新 revision（每次修改 +1；夹具的员工侧字段替身
 * 不放行 revision，响应里读不到）。
 */
async function setWorkEmail(w: World360, employeeId: string, workEmail: string, revision: number): Promise<number> {
  const res = await w.api.request('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
    user: w.admin,
    tenant: w.tenantId,
    ifMatch: revision,
    body: { workEmail },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return revision + 1;
}

async function finePermissionOn(w: World360) {
  const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
  await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
}

const sync = (w: World360, body: Record<string, unknown>, user?: string) =>
  w.ok<SyncPage>((user ? w.as(user) : w.request)('POST', '/people/sync', { body }));

const mail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;

describe('R4-P2-1 邮箱改归属后，原键重放不返回范围外人员的历史结果', () => {
  it('范围甲 + 乙时用乙的邮箱新增评价对象、评价者并导入关系；乙的旧邮箱转给甲、范围收窄到甲后，三条原键重放都不带乙的数据', async () => {
    const w = await world360(testDb().db, 'r5a', { access: fullAccess() });
    await finePermissionOn(w);
    const orgA = await w.session.org('甲部门', { establishedOn: '2025-01-01' });
    const orgB = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
    const jia = await w.session.employee('员工甲');
    const yi = await w.session.employee('员工乙');
    const bing = await w.session.employee('员工丙');
    await hire(w, jia, orgA.id);
    await hire(w, yi, orgB.id);
    await hire(w, bing, orgA.id);
    const oldEmail = mail('yi-old');
    const jiaRevision = await setWorkEmail(w, jia.id, mail('jia'), 0);
    const yiRevision = await setWorkEmail(w, yi.id, oldEmail, 0);
    await sync(w, {});
    const listed = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
    const personOf = (employeeId: string) => listed.find((p) => p.employeeId === employeeId)!;
    const [pJia, pYi, pBing] = [personOf(jia.id), personOf(yi.id), personOf(bing.id)];
    expect(pYi.email).toBe(oldEmail);

    // 受限的高级管理员：（用户 × Survey360）范围先是甲部门 + 乙部门
    const mou = async (code: string, orgIds: readonly string[]) =>
      (
        await w.ok<{ id: string }>(
          w.enterprise('POST', '/mous', {
            ifMatch: 0,
            body: { code, name: code, orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
          }),
          201,
        )
      ).id;
    const wide = await mou('mou-r5-wide', [orgA.id, orgB.id]);
    const narrow = await mou('mou-r5-narrow', [orgA.id]);
    const admin = await w.member('受限管理员');
    await w.appoint(admin, 'advanced');
    const assigned = await w.ok<{ revision: number }>(
      w.enterprise('PUT', `/scopes/${admin}/${APP}`, { ifMatch: 0, body: { kind: 'mou', mouId: wide } }),
    );
    const as = w.as(admin);
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity({ name: 'R5 邮箱改归属' }, admin);
    const objectOfJia = await w.ok<ObjectView>(
      as('POST', `/activities/${activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: pJia.id, questionnaireIds: [q.id] },
      }),
      201,
    );

    // 三个入口都用乙的邮箱：新增评价对象、在甲的评价对象下新增评价者、导入以乙为评价对象的关系
    const keys = { object: randomUUID(), appraiser: randomUUID(), imported: randomUUID() };
    const addObject = () =>
      as('POST', `/activities/${activity.id}/objects`, {
        ifMatch: 0,
        idempotencyKey: keys.object,
        body: { person: { name: '员工乙', email: oldEmail }, questionnaireIds: [q.id] },
      });
    const addAppraiser = () =>
      as('POST', `/activities/${activity.id}/objects/${objectOfJia.id}/appraisers`, {
        ifMatch: 0,
        idempotencyKey: keys.appraiser,
        body: { person: { name: '员工乙', email: oldEmail }, roleId: w.role('peer') },
      });
    const importRows = () =>
      as('POST', `/activities/${activity.id}/appraisers/import`, {
        ifMatch: 0,
        idempotencyKey: keys.imported,
        body: {
          sync: true,
          rows: [{ objectEmail: oldEmail, roleId: w.role('peer'), name: '员工丙', email: pBing.email }],
        },
      });
    const objectOfYi = await w.ok<ObjectView>(addObject(), 201);
    expect(objectOfYi.personId).toBe(pYi.id);
    const appraiserYi = await w.ok<RelationView>(addAppraiser(), 201);
    expect(appraiserYi.appraiserPersonId).toBe(pYi.id);
    const imported = await w.ok<{ receipts: { relationId: string }[] }>(importRows());
    const importedRelation = imported.receipts[0]!.relationId;

    // 组织员工侧：乙换新邮箱，甲改用乙的旧邮箱；同步后乙的旧邮箱归甲的 360 人员
    await setWorkEmail(w, yi.id, mail('yi-new'), yiRevision);
    await setWorkEmail(w, jia.id, oldEmail, jiaRevision);
    await sync(w, {});
    // 甲先于乙同步时，第一遍甲的新邮箱仍被乙占用（跳过），再同步一遍
    await sync(w, {});
    expect((await w.ok<PersonView>(w.request('GET', `/people/${pJia.id}`))).email).toBe(oldEmail);
    expect((await w.ok<PersonView>(w.request('GET', `/people/${pYi.id}`))).email).not.toBe(oldEmail);

    // 收窄到只有甲部门：乙的人员已看不到
    await w.ok(
      w.enterprise('PUT', `/scopes/${admin}/${APP}`, {
        ifMatch: assigned.revision,
        body: { kind: 'mou', mouId: narrow },
      }),
    );
    expect((await as('GET', `/people/${pYi.id}`)).status).toBe(404);

    const hidden = [pYi.id, objectOfYi.id, appraiserYi.id, importedRelation];
    const outcome = async (res: Response) => {
      const text = await res.clone().text();
      return { status: res.status, leaked: hidden.filter((id) => text.includes(id)) };
    };
    const replays = { object: await addObject(), appraiser: await addAppraiser(), imported: await importRows() };
    // 三条都不带乙的任何 ID；与新命令选到看不到的人员同一结果：评价对象 / 评价者 404，导入整批 400 并逐行给原因
    expect({
      object: await outcome(replays.object),
      appraiser: await outcome(replays.appraiser),
      imported: await outcome(replays.imported),
    }).toEqual({
      object: { status: 404, leaked: [] },
      appraiser: { status: 404, leaked: [] },
      imported: { status: 400, leaked: [] },
    });
    const error = ((await replays.imported.json()) as { error: { code: string; details: unknown } }).error;
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'IMPORT_INVALID', errors: [{ row: 1, details: { reason: 'OBJECT_NOT_FOUND' } }] },
    });
  });
});

describe('R4-P2-2 创建人范围下，回补游标按实际 360 人员与创建人判定', () => {
  it('首人 EMAIL_TAKEN 后跟随返回的游标、limit=1 续页：第二人照常回补，游标不退回 backfill:', async () => {
    const w = await world360(testDb().db, 'r5b', { access: fullAccess() });
    await finePermissionOn(w);
    // 360 人员的数据权限按创建人（using_user，创建人字段缺省 createdBy）：受限管理员看得到自己同步建的人员
    await w.ok(
      w.enterprise('PUT', `/scope-policies/${APP}/${PERSON}/entity/${PERSON}`, {
        ifMatch: 0,
        body: { rules: [{ dimension: 'using_user' }] },
      }),
    );
    const org = await w.session.org('回补部门', { establishedOn: '2025-01-01' });
    // 同步按员工 ID 分页：ID 小的两名作下属、最大的作经理，下属先于经理同步
    const ordered = [
      await w.session.employee('下属甲'),
      await w.session.employee('下属乙'),
      await w.session.employee('经理'),
    ].sort((x, y) => (x.id < y.id ? -1 : 1));
    const [sub1, sub2, boss] = ordered as [(typeof ordered)[0], (typeof ordered)[0], (typeof ordered)[0]];
    await hire(w, boss, org.id);
    await hire(w, sub1, org.id, boss.id);
    await hire(w, sub2, org.id, boss.id);
    const admin = await w.member('创建人范围管理员');
    await w.appoint(admin, 'advanced');
    const as = w.as(admin);

    // 管理员先同步两名下属：经理还没有 360 人员，下属上级为空；两名下属的人员由该管理员创建，均可见
    const first = await sync(w, { limit: 2 }, admin);
    expect(first.created.map((c) => c.employeeId)).toEqual([sub1.id, sub2.id]);
    const personOf = (employeeId: string) => first.created.find((c) => c.employeeId === employeeId)!.personId;
    for (const sub of [sub1, sub2]) expect((await as('GET', `/people/${personOf(sub.id)}`)).status).toBe(200);

    // 首名下属的组织邮箱已被另一名 360 人员占用：回补他时 EMAIL_TAKEN
    const taken = mail('taken');
    await w.person('占用邮箱的外部人员', { email: taken });
    await setWorkEmail(w, sub1.id, taken, 0);

    const pages: SyncPage[] = [];
    let cursor = first.nextCursor;
    for (let i = 0; i < 5 && cursor !== null; i += 1) {
      const page = await sync(w, { after: cursor, limit: 1 }, admin);
      pages.push(page);
      cursor = page.nextCursor;
    }
    // 第一页：员工阶段同步经理，随后回补首名下属（邮箱被占用，跳过），游标停在他之后
    expect(pages[0]!.created.map((c) => c.employeeId)).toEqual([boss.id]);
    expect(pages[0]!.skipped).toEqual([{ employeeId: sub1.id, reason: 'EMAIL_TAKEN' }]);
    expect(pages[0]!.nextCursor).toBe(`backfill:${sub1.id}`);
    // 续页回补第二名下属，补完报结束；游标从不退回 backfill:
    expect(pages.flatMap((p) => p.updated.map((u) => u.employeeId))).toEqual([sub2.id]);
    expect(pages.map((p) => p.nextCursor)).not.toContain('backfill:');
    expect(cursor).toBeNull();
    const bossPerson = pages[0]!.created[0]!.personId;
    const second = await w.ok<PersonView>(as('GET', `/people/${personOf(sub2.id)}`));
    expect(second.superiorPersonId).toBe(bossPerson);
  });
});
