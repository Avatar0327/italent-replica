import { useEffect, useRef, useState } from 'react';
import {
  AVATAR_PATH,
  AvatarApiError,
  avatarRegistration,
  sendAvatarCommand,
  type AvatarCommand,
  type AvatarView,
} from './avatar-api.js';
import { accountText as text } from './messages.js';
import type { AvatarReader } from './useAvatarReader.js';

interface WriteState {
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly error: string;
  readonly notice: string;
}
const INITIAL: WriteState = { busy: false, blocked: false, error: '', notice: '' };

/** 未知结果或 revision 冲突冻结写入，显式回查成功后才能重新提交。 */
export function useAvatarWriter(tenantId: string, reader: AvatarReader, saved: () => void) {
  const [state, setState] = useState(INITIAL);
  const live = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const allowed = () => !working.current && !reader.reading && !!reader.view && !state.blocked;
  const run = async (operation: () => Promise<AvatarView>, deleted = false) => {
    working.current = true;
    setState({ ...INITIAL, busy: true });
    try {
      const result = await operation();
      if (!live.current) return;
      reader.setView(result);
      saved();
      setState({ ...INITIAL, notice: deleted ? text.deleted : text.saved });
    } catch (cause) {
      if (!live.current) return;
      const rejected = cause instanceof AvatarApiError;
      setState({
        ...INITIAL,
        blocked: !rejected || cause.status === 409,
        error: rejected ? (cause.status === 409 ? text.conflict : cause.message) : text.uncertain,
      });
      // 删除明确拒绝没有改变头像；授权失败才清旧图，上传则需回查登记后的 revision。
      if (rejected && ([401, 403, 404].includes(cause.status) || (!deleted && cause.status !== 409)))
        await reader.load();
    } finally {
      working.current = false;
      if (live.current) setState((value) => ({ ...value, busy: false }));
    }
  };
  const save = (file: File) => {
    if (!allowed()) return;
    const revision = reader.view!.revision;
    void run(async () => {
      const prepared = await avatarRegistration(file, revision);
      if (!live.current) throw new Error(text.failed);
      const registration = await sendAvatarCommand<{ revision: number; attachment: { id: string } }>(
        tenantId,
        prepared.command,
      );
      if (!live.current) throw new Error(text.failed);
      return sendAvatarCommand<AvatarView>(tenantId, {
        path: `${AVATAR_PATH}/attachments/${registration.attachment.id}/upload`,
        method: 'POST',
        key: `${prepared.command.key}:upload`,
        revision: registration.revision,
        body: { base64: prepared.base64 },
      });
    });
  };
  const remove = () => {
    if (!allowed()) return;
    const command: AvatarCommand = {
      path: AVATAR_PATH,
      method: 'DELETE',
      key: crypto.randomUUID(),
      revision: reader.view!.revision,
    };
    void run(() => sendAvatarCommand<AvatarView>(tenantId, command), true);
  };
  const refresh = async () => {
    if (working.current || reader.reading) return;
    if ((await reader.load()) && live.current) {
      setState(INITIAL);
      saved();
    }
  };
  return { ...state, save, remove, refresh };
}
