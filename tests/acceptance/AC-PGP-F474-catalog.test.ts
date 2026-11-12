import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as domain from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';

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
  it('AC-PGP-F474-03 基线授权编码指纹、版本、changes 与 HISTORY 原文件不变', () => {
    expect(domain.grantCodesDigest(domain.STANDARD_GRANT_CODES)).toBe('acbafd07e26b55e1');
    expect(domain.STANDARD_GRANT_DIGEST).toBe('acbafd07e26b55e1');
    expect(domain.STANDARD_GRANT_VERSION).toBe(52);
    for (const [path, hash] of [
      [
        'packages/domain/src/platform/standard-grant-changes.json',
        'a5db2382809579f33b8fda1b832333eab4dc4b713a7c5b30d5962b08676499b6',
      ],
      [
        'tests/acceptance/AC-PLAT-F061-grants.test.ts',
        '64a84b1d8cd25af97238bd118d88376440cfda4601b519f5ea5e6d615921dfdc',
      ],
    ])
      expect(createHash('sha256').update(readFileSync(path!)).digest('hex'), path).toBe(hash);
  });
});
