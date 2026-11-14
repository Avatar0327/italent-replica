import * as domain from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { GRANTS_PATH, readGrantConstants } from '../../scripts/merge-main-lib.mjs';
import { fileNow } from './support/grant-baseline.js';

describe('AC-PGP-F474-01～03 页面目录与授权边界', () => {
  it('AC-PGP-F474-01 目录逐页对应载体按钮，载体无字段且层级均为 app_page', () => {
    const pages = Reflect.get(domain, 'PAGE_CATALOG') as
      | {
          pageCode: string;
          appCode: string;
          name: string;
          carrierObject: string;
        }[]
      | undefined;
    expect(pages).toEqual([
      {
        pageCode: 'EmployeeDevelopmentChannel',
        appCode: 'Qualification',
        name: '员工发展通道',
        carrierObject: 'Qualification.Pages',
      },
    ]);
    const carriers = Reflect.get(domain, 'PAGE_CARRIERS') as domain.ObjectDefinition[];
    expect(carriers).toEqual([domain.QUALIFICATION_PAGES]);
    for (const carrier of carriers) {
      expect(carrier.fields).toEqual([]);
      expect(carrier.buttons).toEqual(
        pages!.filter((p) => p.carrierObject === carrier.code).map((p) => ({ code: p.pageCode, level: 'app_page' })),
      );
      expect(
        pages!.filter((p) => p.carrierObject === carrier.code).every((p) => p.appCode === carrier.application),
      ).toBe(true);
    }
  });
  it('AC-PGP-F474-02 载体只进 objectCatalog，不进业务对象集合', () => {
    expect(objectCatalog.get('Qualification.Pages')).toEqual(domain.QUALIFICATION_PAGES);
    for (const [key, value] of Object.entries(domain)) {
      if (!key.endsWith('_OBJECTS') || !value || typeof value !== 'object') continue;
      expect(
        Object.values(value).map((o) => o?.code),
        key,
      ).not.toContain('Qualification.Pages');
    }
  });
  it('AC-PGP-F474-03 页面载体只在既有的员工身份预置，授权编码与其它标准预置身份都不引用', () => {
    // 9b 本意（F-474-9a 设计 §4）：页面权限只走身份 / 租户保存的页面载体授权，不新增授权项编码、不改任何预置身份。
    // 唯一的既有例外是员工自助身份（设计 §2：预置「员工」身份本来就带 Qualification.Pages 与员工发展通道按钮，
    // DEC-402①），所以断言“载体授权只出现在员工身份，且就是页面目录里的那几个按钮、没有数据操作”。
    // 本用例合入 main 后长期成立；相对基线的编码增删、版本、changes、HISTORY 登记由 AC-PLAT-F061-grants
    // （F-097 动态基线）统一把关，不在此逐项比对，否则之后任何正当新增授权项的 PR 都会被判红。
    const EMPLOYEE = 'employee_self_service';
    const carriers = new Set(domain.PAGE_CARRIERS.map((carrier) => carrier.code));
    const pageCodes = domain.PAGE_CATALOG.map((page) => page.pageCode);
    expect(carriers.size, '载体清单不为空，下面的守卫才有对象可查').toBeGreaterThan(0);
    expect(pageCodes.length, '页面目录不为空').toBeGreaterThan(0);
    // 编码形如 `<身份>/<对象>/…`、`<身份>/seeAll:<应用>:<种类>:<对象>`：载体编码与页面编码出现在任何位置都算引用
    const referencing = domain.STANDARD_GRANT_CODES.filter(
      (code) =>
        [...carriers].some((carrier) => code.includes(carrier)) || pageCodes.some((page) => code.includes(page)),
    );
    expect(
      referencing.filter((code) => !code.startsWith(`${EMPLOYEE}/`)),
      '员工身份以外的标准授权项编码不得引用页面载体或页面编码',
    ).toEqual([]);
    for (const profile of domain.STANDARD_PROFILES) {
      const carrierRows = profile.objects.filter((object) => carriers.has(object.objectCode));
      const carrierSeeAll = (profile.seeAll ?? []).filter((target) => carriers.has(target.targetCode));
      expect(carrierSeeAll, `${profile.code} 预置了页面载体的看全部`).toEqual([]);
      if (profile.code !== EMPLOYEE) {
        expect(carrierRows, `${profile.code} 预置了页面载体对象授权`).toEqual([]);
        continue;
      }
      // 员工身份的载体行：只授页面（app_page 按钮，且在目录里），不夹带数据操作与字段（设计 R1）
      for (const row of carrierRows) {
        expect(Object.values(row.dataOperations), `${row.objectCode} 载体行不得带数据操作`).not.toContain(true);
        expect(row.fields, `${row.objectCode} 载体无字段`).toEqual([]);
        for (const button of row.buttons) {
          expect(button.level).toBe('app_page');
          expect(pageCodes).toContain(button.buttonCode);
        }
      }
    }
    // 自洽：指纹常量与编码集合一致，且与 standard-grants.ts 里的字面量一致（不比较分叉点）
    expect(domain.grantCodesDigest(domain.STANDARD_GRANT_CODES)).toBe(domain.STANDARD_GRANT_DIGEST);
    const constants = readGrantConstants(fileNow(GRANTS_PATH)!);
    expect(domain.STANDARD_GRANT_VERSION).toBe(constants.version);
    expect(domain.STANDARD_GRANT_DIGEST).toBe(constants.digest);
  });
});
