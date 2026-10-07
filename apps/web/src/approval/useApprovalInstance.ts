import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadApprovalDetail, permissionFailure, requestMessage } from './api.js';
import { text } from './messages.js';
import { createRequestLane, STALE, type RequestLane } from './requestLane.js';
import type { ApprovalDetail } from './types.js';

/** 下发给命令层与历史层：所有请求经同一通道串行；收紧信号只能触发“清空 + 整页重读”。 */
export interface InstanceRequests {
  readonly run: RequestLane['run'];
  readonly tighten: () => void;
}
/**
 * DEC-277：实例的本地状态只来自完整详情响应的整体替换，不做局部合并或乐观更新。
 * 收紧信号（历史分页 recordsHidden、历史 / 写请求 403、字段消失）先清空已展示数据，再整页重读；
 * 重读失败保持清空并提示“数据已更新，请重试”。
 */
export function useApprovalInstance(tenantId: string, instanceId: string, onDenied: () => void) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const reading = useRef(0);
  const [lane] = useState(createRequestLane);
  const denied = useRef(onDenied);
  denied.current = onDenied;
  /** 完整详情读取被拒：清空并关闭该单，排队中的请求一并丢弃。 */
  const clear = useCallback(() => {
    lane.reset();
    setDetail(null);
    setNotice('');
    setError(text.forbidden);
    denied.current();
  }, [lane]);
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
            return await loadApprovalDetail(tenantId, instanceId, signal);
          } catch (failure) {
            if (active.current && permissionFailure(failure)) clear();
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
    [tenantId, instanceId, lane, clear],
  );
  const refresh = useCallback(() => read(true), [read]);
  /** 写响应是完整详情：整体替换。 */
  const replace = useCallback((result: ApprovalDetail) => {
    if (!active.current) return;
    setDetail(result);
    setError('');
    setNotice('');
  }, []);
  const tighten = useCallback(() => {
    if (!active.current) return;
    lane.reset();
    setDetail(null);
    setError('');
    setNotice(text.staleRetry);
    void read(false).catch(() => undefined);
  }, [lane, read]);
  const requests = useMemo<InstanceRequests>(() => ({ run: lane.run, tighten }), [lane, tighten]);
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
