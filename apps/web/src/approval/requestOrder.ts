/**
 * 同一审批实例全部读写请求的代次台账（AC-APV-UI-02 / 04，第 3、4 轮）。
 *
 * 规则：响应只有在"没有更晚发出的响应已被采用"时才能改变页面上的披露状态，否则整条作废。
 * 详情 GET 发出时即作废更早的未决请求；写 POST 与历史分页 GET 只领取代次。
 * 历史接口报告隐藏（DEC-115）同样作为"采用"记入台账，使更早发出的详情 GET 与写响应不能把披露放宽。
 * 只按发出顺序判断，不比较 revision：催办与权限变化未必推进 revision。
 */
export interface RequestOrder {
  /** 发出一个请求，返回其代次。 */
  issue(): number;
  /** 发出一个请求并作废所有更早发出的未决请求（详情 GET）。 */
  issueLatest(): number;
  /** 响应到达：只有比已采用的更晚才采用，并记为已采用。 */
  settle(ticket: number): boolean;
  /** 作废全部未决请求（清理、卸载）。 */
  invalidate(): void;
}
export function createRequestOrder(): RequestOrder {
  let issued = 0;
  let settled = 0;
  return {
    issue: () => ++issued,
    issueLatest() {
      settled = issued;
      return ++issued;
    },
    settle(ticket) {
      if (ticket <= settled) return false;
      settled = ticket;
      return true;
    },
    invalidate() {
      settled = ++issued;
    },
  };
}
