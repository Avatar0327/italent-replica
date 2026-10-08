import { text } from './messages.js';
import type { TalentWrite } from './useTalentWrite.js';

/** 写入结果、错误、结果未知时的“重试原请求”，以及没有数据权限的提示。 */
export function Status({ write, hasDataPermission }: { write: TalentWrite; hasDataPermission: boolean }) {
  return (
    <>
      {!hasDataPermission && <p role="note">{text.noPermission}</p>}
      {write.error && <p role="alert">{write.error}</p>}
      {write.notice && <p role="status">{write.notice}</p>}
      {write.unknown && (
        <button disabled={write.busy} onClick={write.retry}>
          {text.retry}
        </button>
      )}
    </>
  );
}

export function Pager({
  list,
  locked,
}: {
  list: { page: number; hasNext: boolean; setPage: (page: number) => void };
  locked: boolean;
}) {
  return (
    <nav>
      <button disabled={locked || list.page === 1} onClick={() => list.setPage(list.page - 1)}>
        {text.previous}
      </button>
      <button disabled={locked || !list.hasNext} onClick={() => list.setPage(list.page + 1)}>
        {text.next}
      </button>
    </nav>
  );
}
