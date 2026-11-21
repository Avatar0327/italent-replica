import { describe, expect, it } from 'vitest';
import { ApiError } from '../foundation/client.js';
import { errorText } from './model.js';

describe('AC-FE-R2f-11 名册的机器错误码与中文反馈', () => {
  it('响应体过大时提示缩小筛选范围', () => {
    const failure = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'unknown', 'ZZ_FER2F_服务端消息');
    expect(errorText(failure)).toBe('请求内容过大，请缩小筛选范围');
  });

  it('超限必须同时命中状态、错误码与原因', () => {
    const details = { details: { reason: 'EXPORT_ROW_LIMIT' } };
    const failure = new ApiError(422, 'VALIDATION_FAILED', 'fields', 'ZZ_FER2F_服务端消息', details);
    expect(errorText(failure, true)).toBe('导出最多 10000 行，请缩小筛选范围');
    expect(errorText(new ApiError(400, 'VALIDATION_FAILED', 'fields', '', details), true)).toBe(
      '请检查筛选条件和日期范围',
    );
    expect(errorText(new ApiError(422, 'REQUEST_FAILED', 'fields', '', details), true)).toBe('导出失败，请重试');
    expect(errorText(new ApiError(422, 'VALIDATION_FAILED', 'fields', ''), true)).toBe('导出失败，请重试');
  });
});
