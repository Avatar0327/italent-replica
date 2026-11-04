/**
 * F-174（#347 第 1 轮 P3）：离职字典编码的大小写口径。编码租户内唯一且不分大小写（设计 §2.1），选择校验本来就不分大小写，
 * 按编码取名称也必须同口径，否则新增 MIXED 后用 mixed 通过选择校验、回显名称却为空。
 * 选择校验 / 名称回显是服务端端口（尚无公开入口），服务层直接调用；字典项经公开 HTTP 新增。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld } from './AC-EXIT-support.js';
import * as dictionaries from '../../apps/api/src/modules/employment/exit-dictionaries.js';

const testDb = useTestDb();

describe('F-174 离职字典编码大小写口径', () => {
  it('新增 MIXED 后：mixed / MIXED 都通过选择校验，按任一写法取名称都非空，结果以请求写法为键', async () => {
    const w = await exitWorld(testDb().db, 'f174-case');
    await w.added('types', { code: 'MIXED', name: '大小写混合' });
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const code of ['MIXED', 'mixed', 'Mixed']) {
        await expect(dictionaries.assertExitDictionaryEnabled(tx, w.tenant.id, 'types', code)).resolves.toBeUndefined();
      }
      const names = await dictionaries.exitDictionaryNames(tx, w.tenant.id, 'types', ['mixed', 'MIXED', 'voluntary']);
      expect(Object.fromEntries(names)).toEqual({ mixed: '大小写混合', MIXED: '大小写混合', voluntary: '主动离职' });
    });
  });

  it('反例：只差一个字符的编码仍是未知项；停用项选择被拒但名称照常回显；别的字典与别的租户的同编码不串', async () => {
    const w = await exitWorld(testDb().db, 'f174-negative');
    const other = await exitWorld(testDb().db, 'f174-negative-other');
    const created = await w.added('types', { code: 'MIXED', name: '大小写混合' });
    await other.added('types', { code: 'MIXED', name: '另一租户的名称' });
    expect((await w.update('types', created.id, created.revision, { enabled: false })).status).toBe(200);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await expect(dictionaries.assertExitDictionaryEnabled(tx, w.tenant.id, 'types', 'mixed')).rejects.toMatchObject({
        details: { reason: 'EXIT_DICTIONARY_DISABLED', code: 'mixed' },
      });
      await expect(dictionaries.assertExitDictionaryEnabled(tx, w.tenant.id, 'types', 'mixedx')).rejects.toMatchObject({
        details: { reason: 'EXIT_DICTIONARY_UNKNOWN' },
      });
      const names = await dictionaries.exitDictionaryNames(tx, w.tenant.id, 'types', ['mixed', 'mixedx']);
      expect(Object.fromEntries(names)).toEqual({ mixed: '大小写混合' });
      expect((await dictionaries.exitDictionaryNames(tx, w.tenant.id, 'reasons', ['mixed'])).size).toBe(0);
    });
  });
});
