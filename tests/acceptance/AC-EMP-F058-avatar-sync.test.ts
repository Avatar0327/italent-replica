/** F-058：同步冲突中的具名候选也引用真实头像，姓名字段撤权不能留下识别引用。 */
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type ObjectPermissionBody, type PersonView, world360 } from './AC-360-support.js';
import { avatarEmployee, employeeAvatar, type AvatarReference } from './AC-EMP-F058-avatar-support.js';
import { loginEmailOf } from './AC-EMP-support.js';

const testDb = useTestDb();

describe('AC-EMP 补 / F-058 同步冲突候选头像', () => {
  it('已挂接候选引用账号头像；姓名字段撤权后头像引用与姓名均缺席', async () => {
    const w = await world360(testDb().db, 'f058-sync-avatar');
    const org = await w.session.org('同步头像部门', { establishedOn: '2025-01-01' });
    const first = await avatarEmployee(w, '已有头像候选', org.id);
    const avatar = await employeeAvatar(w, first.id);
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const candidate = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people'))).items[0]!;
    const second = await avatarEmployee(w, '邮箱冲突人员', org.id);
    await w.ok(
      w.api.request('PATCH', `/api/tenant/personnel/employees/${second.id}`, {
        user: w.admin,
        tenant: w.tenantId,
        ifMatch: 0,
        body: { workEmail: loginEmailOf(first.id) },
      }),
    );
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const advanced = survey360.SURVEY360_PROFILES.find((p) => p.code === 'standard_360_advanced_admin')!;
    const profileId = await w.defineProfile('同步头像查看身份', advanced.objects);
    const viewer = await w.member('同步头像查看人');
    await w.grantProfile(viewer, profileId);
    const as = w.as(viewer);
    const shown = await w.ok<{
      items: { candidates: { personId: string; name?: string; avatar?: AvatarReference | null }[] }[];
    }>(as('GET', '/people/sync-conflicts'));
    expect(shown.items).toHaveLength(1);
    expect(shown.items[0]!.candidates[0]).toMatchObject({ personId: candidate.id, avatar: avatar.avatar });
    const original = advanced.objects.find((object) => object.objectCode === survey360.SURVEY360_OBJECTS.person.code)!;
    const { objectCode, ...permissions } = original;
    const body: Omit<ObjectPermissionBody, 'objectCode'> = {
      ...permissions,
      fields: survey360.SURVEY360_OBJECTS.person.fields.map((field) => ({
        fieldCode: field.code,
        view: field.code !== 'name',
        edit: !field.system && field.code !== 'name',
      })),
    };
    const profile = await w.ok<{ revision: number }>(w.enterprise('GET', `/profiles/${profileId}`));
    await w.ok(
      w.enterprise('PUT', `/profiles/${profileId}/objects/${objectCode}`, { ifMatch: profile.revision, body }),
    );
    const hidden = await w.ok<typeof shown>(as('GET', '/people/sync-conflicts'));
    expect(hidden.items[0]!.candidates[0]).not.toHaveProperty('name');
    expect(hidden.items[0]!.candidates[0]).not.toHaveProperty('avatar');
    expect(JSON.stringify(hidden)).not.toContain(avatar.avatar.id);
  });
});
