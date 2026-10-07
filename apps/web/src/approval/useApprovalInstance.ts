import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { disclosureTightened, loadApprovalDetail, permissionFailure, requestMessage } from './api.js';
import { text } from './messages.js';
import { createRequestLane, STALE, type RequestLane } from './requestLane.js';
import type { ApprovalDetail } from './types.js';

/** 下发给命令层与历史层：所有请求经同一通道串行；收紧信号只能触发“清空 + 整页重读”或“清空 + 整页刷新”。 */
export interface InstanceRequests {
  readonly run: RequestLane['run'];
  /** 客户端识别的收紧信号（DEC-277 ②）：清空后整页重读。 */
  readonly tighten: () => void;
  /** 发出请求时最后看到的披露版本：在通道任务内读取，排队的请求按发出时（而非排队时）的版本回传。 */
  readonly version: () => string | null;
  /** 采纳一次响应携带的版本；通道已重置（signal 已中止）的响应不计。 */
  readonly saw: (version: string | undefined, signal: AbortSignal) => void;
  /** 服务端判定披露收紧（409 DISCLOSURE_TIGHTENED，DEC-288 止损）：立即清空并整页刷新。 */
  readonly tightened: () => void;
}
interface Signals {
  readonly lane: RequestLane;
  readonly seen: RefObject<string | null>;
  readonly active: RefObject<boolean>;
  readonly onDenied: () => void;
  readonly reload: () => void;
  readonly setDetail: Dispatch<SetStateAction<ApprovalDetail | null>>;
  readonly setError: Dispatch<SetStateAction<string>>;
  readonly setNotice: Dispatch<SetStateAction<string>>;
}
/** 两种“清空”：读取被拒 → 关闭该单；服务端判定收紧 → 整页刷新（只触发一次）。都重置通道并忘掉已看到的版本。 */
function useClearSignals({ lane, seen, active, onDenied, reload, setDetail, setError, setNotice }: Signals) {
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const reloadPage = useRef(reload);
  reloadPage.current = reload;
  const reloading = useRef(false);
  const clear = useCallback(() => {
    lane.reset();
    seen.current = null;
    setDetail(null);
    setNotice('');
    setError(text.forbidden);
    denied.current();
  }, [lane, seen, setDetail, setError, setNotice]);
  const tightened = useCallback(() => {
    if (!active.current || reloading.current) return;
    reloading.current = true;
    lane.reset();
    seen.current = null;
    setDetail(null);
    setError('');
    setNotice(text.disclosureRefresh);
    reloadPage.current();
  }, [lane, seen, active, setDetail, setError, setNotice]);
  /** 写响应是完整详情：整体替换（版本已在通道任务内采纳）。 */
  const replace = useCallback(
    (result: ApprovalDetail) => {
      if (!active.current) return;
      seen.current = result.disclosureVersion ?? seen.current;
      setDetail(result);
      setError('');
      setNotice('');
    },
    [seen, active, setDetail, setError, setNotice],
  );
  return { clear, tightened, reloading, replace };
}
/**
 * DEC-277：实例的本地状态只来自完整详情响应的整体替换，不做局部合并或乐观更新。
 * 收紧信号（历史分页 recordsHidden、历史 / 写请求 403、字段消失）先清空已展示数据，再整页重读；
 * 重读失败保持清空并提示“数据已更新，请重试”。
 * DEC-288 止损：每个读写请求回传最后看到的披露版本；服务端判定收紧即清空详情并整页刷新，不再局部补救。
 */
export function useApprovalInstance(tenantId: string, instanceId: string, onDenied: () => void, reload: () => void) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const reading = useRef(0);
  const [lane] = useState(createRequestLane);
  /** 最后看到的披露版本；清空（被拒、收紧、刷新）后归零，重读不回传旧版本。 */
  const seen = useRef<string | null>(null);
  const signals = { lane, seen, active, onDenied, reload, setDetail, setError, setNotice };
  const { clear, tightened, reloading, replace } = useClearSignals(signals);
  /**
   * 收紧信号在通道任务内部发出（结果返回前）：通道随即重置，排队中的请求不会先行发出，
   * 本任务自身的结果也作废；整页重读排在其后。
   */
  const read = useCallback(
    async (manual: boolean): Promise<ApprovalDetail | null> => {
      reading.current++;
      setLoading(true);
      try {
        const result = await lane.run(async (signal) => {
          try {
            const loaded = await loadApprovalDetail(tenantId, instanceId, signal, seen.current);
            if (!signal.aborted) seen.current = loaded.disclosureVersion ?? seen.current;
            return loaded;
          } catch (failure) {
            if (active.current && permissionFailure(failure)) clear();
            else if (active.current && disclosureTightened(failure)) tightened();
            throw failure;
          }
        });
        if (!active.current || result === STALE) return null;
        setDetail(result);
        setError('');
        if (manual) setNotice('');
        return result;
      } catch (failure) {
        if (!active.current) return null;
        setError(requestMessage(failure));
        throw failure;
      } finally {
        reading.current--;
        if (active.current && reading.current === 0) setLoading(false);
      }
    },
    [tenantId, instanceId, lane, clear, tightened],
  );
  const refresh = useCallback(() => read(true), [read]);
  const tighten = useCallback(() => {
    if (!active.current || reloading.current) return;
    lane.reset();
    seen.current = null;
    setDetail(null);
    setError('');
    setNotice(text.staleRetry);
    void read(false).catch(() => undefined);
  }, [lane, read, reloading]);
  const requests = useMemo<InstanceRequests>(
    () => ({
      run: lane.run,
      tighten,
      tightened,
      version: () => seen.current,
      saw: (version, signal) => {
        if (version && !signal.aborted) seen.current = version;
      },
    }),
    [lane, tighten, tightened],
  );
  useEffect(() => {
    active.current = true;
    void read(false).catch(() => undefined);
    return () => {
      active.current = false;
      lane.reset();
    };
  }, [lane, read]);
  return { detail, loading, error, notice, refresh, replace, tighten, requests };
}
