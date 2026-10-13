/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationCommand } from '../../apps/web/src/self-service/shared/application-command.js';
import type { TransferBusiness } from '../../apps/web/src/transfer/types.js';
import type { useApplicationCommand as Hook } from '../../apps/web/src/self-service/pages/useApplicationCommand.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { useApplicationCommand } = await import(resolve('apps/web/src/self-service/pages/useApplicationCommand.ts'));
const { TransferApiError } = await import(resolve('apps/web/src/transfer/api.ts'));
const command: ApplicationCommand = {
  commandId: 'original-command',
  employeeId: 'synthetic-employee',
  action: 'submit',
  effectiveDate: '2026-10-13',
  summary: { fields: { departmentId: 'synthetic-department' } },
};
const result: TransferBusiness = { id: 'synthetic-business', status: 'draft', revision: 3, employeeRevision: 7 };
async function withState(check: (state: () => ReturnType<typeof Hook>) => Promise<void>, scope = crypto.randomUUID()) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  let state: ReturnType<typeof Hook>;
  function Probe() {
    state = useApplicationCommand(scope);
    return null;
  }
  try {
    await act(() => root.render(h(Probe)));
    await check(() => state);
  } finally {
    await act(() => root.unmount());
  }
}

describe('AC-FE-R1d-2 页面级统一命令入口', () => {
  it('同步重复触发被单一入口拦截，迟到暂存回执只能登记一次原单', async () => {
    await withState(async (state) => {
      let resolveWrite!: (value: TransferBusiness) => void;
      const write = vi.fn(
        () =>
          new Promise<TransferBusiness>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      let pending!: Promise<TransferBusiness>;
      await act(async () => {
        pending = state().run(command, write);
        await expect(state().run({ ...command, commandId: 'second-command' }, write)).rejects.toThrow();
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(state().pending).toEqual(command);
      await act(async () => {
        resolveWrite(result);
        await pending;
      });
      expect(state().saved).toEqual(result);
      expect(state().pending).toBeNull();
    });
  });
  for (const failure of [new TypeError('network failed'), new TransferApiError('UNAVAILABLE', '暂不可用', 503)])
    it(`未确认 ${failure.name} 后原命令与摘要保持，新命令不可执行`, async () => {
      await withState(async (state) => {
        await act(async () => {
          await expect(
            state().run(command, async () => {
              throw failure;
            }),
          ).rejects.toThrow();
        });
        const retry = vi.fn(async () => result);
        await expect(state().run({ ...command, commandId: 'new-command' }, retry)).rejects.toThrow();
        expect(retry).not.toHaveBeenCalled();
        expect(state().pending).toEqual(command);
      });
    });
  it('确定的 revision 拒绝解除处理中标记，保留原暂存对象并显示冲突', async () => {
    await withState(async (state) => {
      await act(async () => {
        await state().run(command, async () => result);
      });
      await act(async () => {
        await expect(
          state().run({ ...command, businessId: result.id }, async () => {
            throw new TransferApiError('REVISION_CONFLICT', '冲突', 409);
          }),
        ).rejects.toThrow();
      });
      expect(state().pending).toBeNull();
      expect(state().saved).toEqual(result);
      expect(state().error).toContain('数据已发生变化');
    });
  });
  it('成功状态但缺少有效业务回执仍锁定，不把不完整响应视为已完成', async () => {
    await withState(async (state) => {
      await act(async () => {
        await expect(state().run(command, async () => ({ ...result, id: '' }))).rejects.toThrow();
      });
      expect(state().pending).toEqual(command);
      expect(state().saved).toBeNull();
    });
  });
  it('路由重挂载保留只读命令标记，其他租户身份入口作用域不继承', async () => {
    const scope = crypto.randomUUID();
    await withState(async (state) => {
      await act(async () => {
        await expect(
          state().run(command, async () => {
            throw new TypeError('network');
          }),
        ).rejects.toThrow();
        state().clearConfirmed();
      });
      expect(state().pending).toEqual(command);
    }, scope);
    await withState(async (state) => {
      expect(state().pending).toEqual(command);
    }, scope);
    await withState(async (state) => {
      expect(state().pending).toBeNull();
      expect(state().saved).toBeNull();
    });
  });
});
