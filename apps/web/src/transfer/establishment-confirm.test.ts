/**
 * F-026：超编确认的共用判定与重提循环（HR 转调动、自助转调动、草稿提交、任职记录编辑共用）。
 * 错误对象经真实的 ApiError 构造，details 形状同后端 errors.ts errorResponse + requireEstablishmentConfirmed。
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../foundation/client.js';
import { TransferApiError } from './api.js';
import { needsEstablishmentConfirm, sendWithEstablishmentConfirm } from './establishment-confirm.js';

const apiError = (status: number, code: string, reason?: string) =>
  new ApiError(status, code, 'conflict', '已超出设定编制，确认后继续保存', {
    code,
    message: '已超出设定编制，确认后继续保存',
    details: reason ? { reason, warnings: [{ departmentId: 'd1', reason: 'ESTABLISHMENT_EXCEEDED' }] } : undefined,
  });

describe('AC-FE-F026 needsEstablishmentConfirm', () => {
  it('409 + CONFIRMATION_REQUIRED（ApiError 与 TransferApiError）才算要确认', () => {
    expect(needsEstablishmentConfirm(apiError(409, 'CONFLICT', 'CONFIRMATION_REQUIRED'))).toBe(true);
    expect(needsEstablishmentConfirm(new TransferApiError('CONFLICT', '', 409, 'CONFIRMATION_REQUIRED'))).toBe(true);
  });
  it('严格控编拒绝、版本冲突、无原因码、非 409、非错误对象都不算', () => {
    expect(needsEstablishmentConfirm(apiError(409, 'CONFLICT', 'ESTABLISHMENT_EXCEEDED'))).toBe(false);
    expect(needsEstablishmentConfirm(apiError(409, 'REVISION_CONFLICT'))).toBe(false);
    expect(needsEstablishmentConfirm(apiError(400, 'CONFLICT', 'CONFIRMATION_REQUIRED'))).toBe(false);
    expect(needsEstablishmentConfirm(new Error('x'))).toBe(false);
    expect(needsEstablishmentConfirm(null)).toBe(false);
  });
});

describe('AC-FE-F026 sendWithEstablishmentConfirm', () => {
  const need = () => apiError(409, 'CONFLICT', 'CONFIRMATION_REQUIRED');
  it('不需要确认：只发一次，不询问', async () => {
    const sent: boolean[] = [];
    let asked = 0;
    const result = await sendWithEstablishmentConfirm(
      async (confirmed) => (sent.push(confirmed), 'ok'),
      async () => (asked++, true),
    );
    expect([result, sent, asked]).toEqual(['ok', [false], 0]);
  });
  it('要确认且同意：以 confirmed=true 重提一次', async () => {
    const sent: boolean[] = [];
    const result = await sendWithEstablishmentConfirm(
      async (confirmed) => {
        sent.push(confirmed);
        if (!confirmed) throw need();
        return 'saved';
      },
      async () => true,
    );
    expect([result, sent]).toEqual(['saved', [false, true]]);
  });
  it('要确认但取消：抛出原错误，不重提', async () => {
    const sent: boolean[] = [];
    const original = need();
    await expect(
      sendWithEstablishmentConfirm(
        async (confirmed) => {
          sent.push(confirmed);
          throw original;
        },
        async () => false,
      ),
    ).rejects.toBe(original);
    expect(sent).toEqual([false]);
  });
  it('带 confirmed 后仍要确认：原样抛出，不循环', async () => {
    const sent: boolean[] = [];
    let asked = 0;
    await expect(
      sendWithEstablishmentConfirm(
        async (confirmed) => {
          sent.push(confirmed);
          throw need();
        },
        async () => (asked++, true),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect([sent, asked]).toEqual([[false, true], 1]);
  });
  it('其他错误（严格拒绝）不询问，原样抛出', async () => {
    let asked = 0;
    await expect(
      sendWithEstablishmentConfirm(
        async () => {
          throw apiError(409, 'CONFLICT', 'ESTABLISHMENT_EXCEEDED');
        },
        async () => (asked++, true),
      ),
    ).rejects.toMatchObject({ reason: 'ESTABLISHMENT_EXCEEDED' });
    expect(asked).toBe(0);
  });
});
