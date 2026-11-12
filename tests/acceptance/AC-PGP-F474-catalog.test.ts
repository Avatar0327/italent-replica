import * as domain from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import {
  GRANT_CHANGES_PATH,
  GRANT_HISTORY_PATH,
  GRANTS_PATH,
  readGrantConstants,
} from '../../scripts/merge-main-lib.mjs';
import { fileAt, fileNow, grantCodesAt, resolveGrantBase } from './support/grant-baseline.js';

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
  it('AC-PGP-F474-03 授权编码、指纹、版本、changes 与 HISTORY 均与分叉点一致（F-097 动态基线）', async (context) => {
    // 不钉死版本号：7b / 8c 等先合入时 main 的版本会变，本单只断言“相对合并基线零变化”。
    const base = resolveGrantBase();
    if ('skip' in base) return context.skip(`F-097 动态基线：${base.skip}`);
    expect([...domain.STANDARD_GRANT_CODES]).toEqual([...(await grantCodesAt(base.sha))]);
    const constants = readGrantConstants(fileAt(base.sha, GRANTS_PATH)!);
    expect(domain.STANDARD_GRANT_VERSION).toBe(constants.version);
    expect(domain.STANDARD_GRANT_DIGEST).toBe(constants.digest);
    expect(domain.grantCodesDigest(domain.STANDARD_GRANT_CODES)).toBe(constants.digest);
    for (const path of [GRANT_CHANGES_PATH, GRANT_HISTORY_PATH])
      expect(fileNow(path), path).toBe(fileAt(base.sha, path));
  });
});
