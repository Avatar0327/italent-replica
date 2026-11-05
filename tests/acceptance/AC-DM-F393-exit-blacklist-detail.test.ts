/**
 * F-352② / F-393：离职详情的加黑三项（有效截止日期 / 加黑原因 / 加黑说明）投影。
 * 三项落在离职扩展行（exit_requests），按任职记录字段查看权裁剪（与 addToBlacklist 同一口径）；
 * 无字段权时键整体缺席，不返回 null，避免用“有没有填”泄露内容。
 * 列表不下发这三项（只在详情）。写入沿用既有加黑写接口与写权，本文件不涉及写入口。
 */
import './support/exit-gate-enforced.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const FULL = [...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code), 'name', 'code'];
const THREE = ['blacklistExpiryDate', 'blacklistReason', 'blacklistNote'] as const;
const BLACKLIST = {
  addToBlacklist: true,
  blacklistReason: 'integrity',
  blacklistExpiryDate: '2026-12-31',
  blacklistNote: '合成加黑说明',
};

async function setup(label: string, exit: object = BLACKLIST) {
  const w = await gateWorld(database().db, label);
  const { employee } = await w.hired('加黑详情员工');
  const { revision } = await w.session.getEmployee(employee.id);
  const response = await w.session.request('POST', `/exits/employees/${employee.id}`, {
    ifMatch: revision,
    body: { mode: 'direct', lastWorkDate: '2026-10-22', exit },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const made = (await response.json()) as { id: string };
  const detail = async (api = w.restricted(denyButtons(), undefined, FULL)) =>
    (await (await api('GET', `/exits/${made.id}`)).json()) as Record<string, unknown>;
  return { w, made, detail };
}

describe('F-393 离职详情加黑三项', () => {
  it('有字段权：详情返回加黑三项的真实值（不是空占位）', async () => {
    const x = await setup('f393-visible');
    expect(await x.detail()).toMatchObject({
      addToBlacklist: true,
      blacklistExpiryDate: '2026-12-31',
      blacklistReason: 'integrity',
      blacklistNote: '合成加黑说明',
    });
  });

  it('永久（有效截止日期为空）与未加黑：三项如实为 null，未加黑时不虚构值', async () => {
    const permanent = await setup('f393-permanent', { addToBlacklist: true, blacklistReason: 'integrity' });
    expect(await permanent.detail()).toMatchObject({
      blacklistExpiryDate: null,
      blacklistReason: 'integrity',
      blacklistNote: null,
    });
    const none = await setup('f393-none', { addToBlacklist: false });
    expect(await none.detail()).toMatchObject({
      addToBlacklist: false,
      blacklistExpiryDate: null,
      blacklistReason: null,
      blacklistNote: null,
    });
  });

  it('逐项撤掉字段权：对应键整体缺席，其余两项与 addToBlacklist 照常返回', async () => {
    const x = await setup('f393-revoke');
    for (const field of THREE) {
      const viewer = x.w.restricted(
        denyButtons(),
        undefined,
        FULL.filter((code) => code !== field),
      );
      const seen = await x.detail(viewer);
      expect(seen, field).not.toHaveProperty(field);
      for (const other of THREE.filter((key) => key !== field)) expect(seen, other).toHaveProperty(other);
      expect(seen.addToBlacklist).toBe(true);
    }
  });

  it('AC-DM-F393 无 addToBlacklist 查看权时，三项仍按各自字段权返回真实值', async () => {
    const x = await setup('f393-no-flag');
    const api = x.w.restricted(
      denyButtons(),
      undefined,
      FULL.filter((field) => field !== 'addToBlacklist'),
    );
    const seen = await x.detail(api);
    expect(seen).not.toHaveProperty('addToBlacklist');
    expect(seen).toMatchObject({
      blacklistExpiryDate: '2026-12-31',
      blacklistReason: 'integrity',
      blacklistNote: '合成加黑说明',
    });
  });

  it('列表行不带加黑三项（只在详情披露）', async () => {
    const x = await setup('f393-list');
    const api = x.w.restricted(denyButtons(), undefined, FULL);
    const page = (await (await api('GET', '/exits?view=all')).json()) as { items: Record<string, unknown>[] };
    expect(page.items).toHaveLength(1);
    for (const field of THREE) expect(page.items[0], field).not.toHaveProperty(field);
  });
});
