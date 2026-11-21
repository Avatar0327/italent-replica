import { describe, expect, it } from 'vitest';
import { retireBody } from './model.js';

describe('AC-FE-R2c3c 退休同时返聘', () => {
  const input = {
    lastWorkDate: '2026-10-25',
    reEmployed: true,
    rehireEmployType: 'internal',
    rehireRemarks: '合成返聘计划',
  };

  it('退休专用创建请求携带返聘计划，服务端决定返聘日', () => {
    expect(retireBody(input, 'direct', undefined)).toEqual({
      mode: 'direct',
      lastWorkDate: '2026-10-25',
      reEmployed: true,
      rehire: { fields: { employType: 'internal', remarks: '合成返聘计划' } },
    });
  });

  it('取消同时返聘后，旧返聘输入不进入普通退休请求', () => {
    expect(retireBody({ ...input, reEmployed: false }, 'application', undefined)).toEqual({
      mode: 'application',
      lastWorkDate: '2026-10-25',
    });
  });
});
