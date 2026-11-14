import { describe, expect, it } from 'vitest';
import { APP_OBJECT_DIRECTORY, objectCatalogDigest, QUALIFICATION_PAGES } from '@italent/domain';
import { pageBody, pageState, pageValues, profileMenuGroups } from './page-permission-model.js';
import { PAGE_CATALOG } from '@italent/domain';
import type { ProfileDetail } from './object-dialog-model.js';
const profile: ProfileDetail = {
  id: 'synthetic',
  name: '合成',
  code: 'employee_self_service',
  description: '',
  source: 'custom',
  apps: ['Qualification'],
  revision: 1,
  autoHeld: true,
  objects: [],
};
describe('AC-PGP-F474 页面默认值和菜单目录', () => {
  it('AC-PGP-F474-08 首次不改选择保存有效默认值，其他身份无缺行默认', () => {
    const values = pageValues(profile, 'Qualification.Pages');
    expect(pageBody(values, 'Qualification.Pages')).toEqual({
      fields: [],
      buttons: [{ buttonCode: 'EmployeeDevelopmentChannel', level: 'app_page' }],
      dataOperations: { create: false, update: false, delete: false },
      catalogDigest: objectCatalogDigest(QUALIFICATION_PAGES),
    });
    expect(pageState({ ...profile, code: 'another' }, PAGE_CATALOG[0]!).granted).toBe(false);
    expect(
      pageBody(pageValues({ ...profile, code: 'another' }, 'Qualification.Pages'), 'Qualification.Pages').buttons,
    ).toEqual([]);
  });
  it('AC-PGP-F474-11 菜单只含该身份所属应用的已授目录对象，按共享目录排序且无隐式默认', () => {
    const codes = ['Qualification.Pages', 'Qualification.EmploymentCategory', 'TenantBase.Employee', 'Unknown.X'];
    const objects = codes.map((objectCode) => ({
      objectCode,
      fields: [],
      buttons: [],
      dataOperations: { create: false, update: false, delete: false },
    }));
    expect(profileMenuGroups({ ...profile, objects })).toEqual([
      { appCode: 'Qualification', objects: APP_OBJECT_DIRECTORY.qualification.filter((code) => codes.includes(code)) },
    ]);
    expect(profileMenuGroups(profile)).toEqual([{ appCode: 'Qualification', objects: [] }]);
    expect(profileMenuGroups({ ...profile, apps: [] })).toEqual([]);
  });
});
