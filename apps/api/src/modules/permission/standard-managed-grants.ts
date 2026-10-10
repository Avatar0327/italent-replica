/**
 * 标准身份的受管授权登记（F-061 方案 §4.4）：每个标准身份在补装台账里登记自己管哪些对象的哪些授权项，
 * 租户保存对象权限（profiles.ts#setObjectPermission）才会把保存前后授予过的项和 @modified 标记记进台账，
 * 回补因此不会把租户撤销过的授权补回。单独成文件、由 profiles.ts 与 standard-seeds.ts 共同 import：
 * 不论哪个入口先加载，登记都已完成（setObjectPermission 不依赖种子登记表是否被收录）。
 */
import { STANDARD_GRANT_ENTRY, STANDARD_PROFILES, standardGrantItems } from '@italent/domain';
import { registerManagedGrants } from '../../seeds/grant-ledger.js';

for (const profile of STANDARD_PROFILES) {
  const byObject = new Map<string, string[]>();
  for (const item of standardGrantItems([profile])) {
    if (item.kind === 'app' || item.kind === 'seeAll') continue;
    byObject.set(item.objectCode, [...(byObject.get(item.objectCode) ?? []), item.code]);
  }
  registerManagedGrants({
    entry: STANDARD_GRANT_ENTRY,
    profileCode: profile.code,
    profileSource: 'standard',
    codesFor: (objectCode) => byObject.get(objectCode) ?? [],
  });
}
