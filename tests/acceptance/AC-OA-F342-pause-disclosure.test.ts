/**
 * F-342（BE-11a 暂停原因 adjustmentCode 按单据可见性裁剪，DEC-406；后补-权限，并入 F-087；与 F-355 共用一组实现）：
 * 执行期间暂停的 409（ORG_ADJUSTMENT_EXECUTING）只对“能打开该调整单”的人给出 adjustmentCode：
 * ① 可见（对象查看权 + 主体组织在主对象范围）→ 照旧给编码；
 * ② 没有对象查看权，或主体组织在主对象范围外 → 只给通用提示（原因码与文案不变），响应里没有编码；
 * ③ 新建（挂到暂停组织下）与修改（改暂停组织）两个入口同口径。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { headWorld, only } from './AC-OA-head-support.js';
import { pauseOrgs } from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const ORGS = '/api/tenant/org/organizations';

/** 一张调整单（主体组织 subject），其调整范围里的甲正处于执行暂停。 */
async function pausedWorld(label: string) {
  const w = await headWorld(testDb().db, label);
  const view = await w.created(w.head({ adjustmentRange: [w.a] }));
  await pauseOrgs(w.db, w.tenant.id, view.id, [w.a]);
  const create = () =>
    w.call('POST', ORGS, { ifMatch: 0, body: { name: '暂停下新建', parents: { admin: { parentId: w.a } } } });
  const rename = async () => {
    const current = await w.call('GET', `${ORGS}/${w.a}`);
    const { revision } = (await current.json()) as { revision: number };
    return w.call('PATCH', `${ORGS}/${w.a}`, {
      ifMatch: revision,
      body: { name: '暂停下改名', effectiveDate: '2026-11-02', addEmployment: false },
    });
  };
  return { w, view, create, rename };
}

async function paused(response: Response) {
  expect(response.status, await response.clone().text()).toBe(409);
  const text = await response.text();
  const body = JSON.parse(text) as { error: { code: string; message: string; details: Record<string, unknown> } };
  expect(body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'ORG_ADJUSTMENT_EXECUTING' } });
  return { error: body.error, text };
}

describe('F-342 暂停原因 adjustmentCode 的可见性', () => {
  it('正向对照：能打开该调整单的人照旧拿到 adjustmentCode（新建与修改两个入口）', async () => {
    const { w, view, create, rename } = await pausedWorld('f342-visible');
    for (const send of [create, rename]) {
      const { error } = await paused(await send());
      expect(error.details).toEqual({ reason: 'ORG_ADJUSTMENT_EXECUTING', adjustmentCode: view.code });
    }
    expect(w.access.viewDenied).toBeUndefined();
  });

  it('没有调整单对象查看权 → 通用提示，响应里没有编码与单据 ID', async () => {
    const { w, view, create, rename } = await pausedWorld('f342-view-denied');
    const visibleMessage = (await paused(await create())).error.message;
    w.access.viewDenied = true;
    for (const send of [create, rename]) {
      const { error, text } = await paused(await send());
      expect(error.details).toEqual({ reason: 'ORG_ADJUSTMENT_EXECUTING' });
      expect(error.message).toBe(visibleMessage);
      expect(text).not.toContain(view.code);
      expect(text).not.toContain(view.id);
    }
  });

  it('主体组织在主对象范围外 → 通用提示（与不存在的单据同样看不到编码）', async () => {
    const { w, view, create, rename } = await pausedWorld('f342-scope');
    w.access.main = only(w.b);
    for (const send of [create, rename]) {
      const { error, text } = await paused(await send());
      expect(error.details).toEqual({ reason: 'ORG_ADJUSTMENT_EXECUTING' });
      expect(text).not.toContain(view.code);
    }
  });
});
