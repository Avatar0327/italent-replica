/**
 * F-479 S5 第 1 轮审查 P2-1：结果未知后的回放收到确定性拒绝（临时附件已过期，后端 400 ATTACHMENT_INVALID）时，
 * 结束恢复、交还提交内核进入可修改的拒绝状态；网络失败 / 5xx 回放仍保留同键重放（防过度修）。
 * 接线照 useSelfRequest.run：真实提交内核（store）+ 真实 API 客户端 + recoverSelfRequest / replaySelfRequest +
 * selfRequestBody / acceptSelfRequest / requestError；后端错误信封照 apps/api/src/modules/attachments/binding.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestError } from '../../part-time/request-model.js';
import { acceptSelfRequest, selfRequestBody } from '../../self-service/pages/request-model.js';
import { pendingReplay, recoverSelfRequest, replaySelfRequest } from '../../self-service/pages/request-replay.js';
import { type Command, createApiClient, rejectionMessage } from '../client.js';
import { createFormStore, isLocked, type Values } from '../forms/store.js';

const COLLECTION = '/api/tenant/self-service/exit-requests';
// 每条用例一张单：恢复槽是模块级的，按路径区分
let ID = '';
let PATH = '';
const EXPIRED = '33333333-3333-4333-8333-000000000001';
const KEPT = '33333333-3333-4333-8333-000000000002';
const FRESH = '33333333-3333-4333-8333-000000000003';
const REASON_CODE = /[A-Z][A-Z0-9]*_[A-Z0-9_]+/;

interface Write {
  body: string;
  revision: string | null;
  key: string | null;
}
type Outcome = 'network' | 503 | 'expired' | 'ok';

/** 合成后端：GET 回查返回草稿；写请求按脚本依次给出网络失败 / 503 / 400 ATTACHMENT_INVALID / 成功回执。 */
function backend(script: Outcome[]) {
  const writes: Write[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return Response.json({ id: ID, employeeId: 'self', revision: 3, status: 'draft' });
      const headers = new Headers(init.headers);
      writes.push({ body: String(init.body), revision: headers.get('if-match'), key: headers.get('idempotency-key') });
      const outcome = script[writes.length - 1] ?? 'ok';
      if (outcome === 'network') throw new TypeError('合成网络错误');
      if (outcome === 503) return new Response(null, { status: 503 });
      if (outcome === 'expired')
        return Response.json(
          { error: { code: 'ATTACHMENT_INVALID', message: '附件不可用，请重新上传', details: { index: 0 } } },
          { status: 400 },
        );
      return Response.json({ id: ID, employeeId: 'self', revision: 4, status: 'draft' });
    }),
  );
  return writes;
}

/** 与 useSelfRequest.run 的暂存同一接线：保存体按可编辑字段裁剪，回执按真实协议校验，错误经 requestError 归一。 */
function saveInput(refs: string[]) {
  const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'identity' }));
  const editable = ['attachmentRefs'];
  return {
    values: { attachmentRefs: refs },
    baseline: { attachmentRefs: [KEPT] },
    editableFields: editable,
    revision: 3,
    businessId: ID,
    patchOnly: true,
    send: async (sent: Command<Values>) => {
      const body = selfRequestBody('exit', sent.body, editable);
      const raw = await recoverSelfRequest(PATH, async () => {
        try {
          return acceptSelfRequest(
            await api.request(PATH, { method: 'PATCH', command: { ...sent, body } }),
            'self',
            sent.revision!,
            ID,
          );
        } catch (cause) {
          throw requestError(cause);
        }
      });
      return { id: raw.id };
    },
  };
}
const reread = () => createApiClient(() => ({ tenantId: 'tenant', identityKey: 'identity' })).request(PATH);

let sequence = 0;
beforeEach(() => {
  ID = `44444444-4444-4444-8444-00000000000${++sequence}`;
  PATH = `${COLLECTION}/${ID}`;
});
afterEach(() => vi.unstubAllGlobals());

describe('AC-FE-ATT-05 P2-1 结果未知后回放遇到附件过期：交还内核、解锁可改', () => {
  it('首次网络失败 → 回放 400 ATTACHMENT_INVALID → 结束恢复、拒绝态解锁、中文提示；删掉失效项重新暂存成功', async () => {
    const writes = backend(['network', 'expired', 'ok']);
    const store = createFormStore();
    const first = store.submit(PATH, saveInput([KEPT, EXPIRED]));
    await vi.waitFor(() => expect(pendingReplay(PATH)).toBeDefined());
    expect(isLocked(store.get(PATH))).toBe(true);

    await replaySelfRequest(PATH, reread);
    await vi.waitFor(() => expect(store.get(PATH)?.status).toBe('rejected'));
    const outcome = await first;
    expect(pendingReplay(PATH)).toBeUndefined();
    expect(isLocked(store.get(PATH))).toBe(false);
    // 回放是原命令：同键、同版本、同请求体
    expect(writes[1]).toEqual(writes[0]);
    const message = rejectionMessage(outcome.error);
    expect(message).toBe('附件不可用，请重新上传');
    expect(message).not.toMatch(REASON_CODE);

    // 用户删掉过期那张、重新上传一张，再暂存：新命令、新键，不再带失效引用，成功
    const again = await store.submit(PATH, saveInput([KEPT, FRESH]));
    expect(again.status).toBe('done');
    expect(writes).toHaveLength(3);
    expect(JSON.parse(writes[2]!.body)).toEqual({ attachmentRefs: [KEPT, FRESH] });
    expect(writes[2]!.key).not.toBe(writes[0]!.key);
    expect(pendingReplay(PATH)).toBeUndefined();
  });

  it.each<Outcome>(['network', 503])('回放仍是 %s：保留待重放、表单保持锁定，下一次仍发同一命令', async (replay) => {
    const writes = backend(['network', replay, 'ok']);
    const store = createFormStore();
    const first = store.submit(PATH, saveInput([KEPT, EXPIRED]));
    await vi.waitFor(() => expect(pendingReplay(PATH)).toBeDefined());

    await replaySelfRequest(PATH, reread);
    expect(store.get(PATH)?.status).toBe('submitting');
    expect(isLocked(store.get(PATH))).toBe(true);
    expect(pendingReplay(PATH)).toBeDefined();
    expect(writes[1]).toEqual(writes[0]);

    await replaySelfRequest(PATH, reread);
    expect((await first).status).toBe('done');
    expect(writes[2]).toEqual(writes[0]);
    expect(pendingReplay(PATH)).toBeUndefined();
  });
});
