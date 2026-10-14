/**
 * 登录限频用的客户端地址提取（F-076 设计 §3.6 代理契约）。与审计的请求上下文（audit/request-context.ts，无条件采信
 * X-Forwarded-For 第一跳）分开：限频身份不能由客户端自己决定。
 * - 只在套接字对端属于 TRUSTED_PROXY_CIDRS 时才读 X-Forwarded-For；否则一律用套接字地址，忽略请求自带的转发头；
 * - 转发头从右往左跳过可信代理的地址，取第一个非可信地址（代理按契约覆盖该头时只有一项）；
 * - IPv4-mapped（::ffff:a.b.c.d）按 IPv4；IPv6 按 /64 聚合；无法解析记为 unknown。
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Context } from 'hono';

export const UNKNOWN_CLIENT = 'unknown';

interface Address {
  readonly family: 'ipv4' | 'ipv6';
  /** IPv4 的点分十进制，或 IPv6 的 8 组 16 位整数。 */
  readonly v4?: string;
  readonly groups?: readonly number[];
}

function ipv6Groups(text: string): number[] | undefined {
  let rest = text.split('%')[0]!;
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(rest)?.[1];
  if (tail4) {
    if (!isIPv4(tail4)) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = tail4.split('.').map(Number);
    rest = `${rest.slice(0, -tail4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const after = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - after.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? gap : 0).fill('0'), ...after];
  return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups.map((g) => parseInt(g, 16)) : undefined;
}

function parseAddress(raw: string | undefined): Address | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (isIPv4(text)) return { family: 'ipv4', v4: text };
  if (!isIPv6(text)) return undefined;
  const groups = ipv6Groups(text);
  if (!groups) return undefined;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return { family: 'ipv4', v4: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}` };
  }
  return { family: 'ipv6', groups };
}

/** 限频桶：IPv4 地址本身，或 IPv6 的 /64 前缀（同一用户通常持有整个 /64）。 */
function bucketOf(address: Address): string {
  if (address.family === 'ipv4') return address.v4!;
  return `${address
    .groups!.slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

const lists = new Map<string, BlockList>();
function trustedList(cidrs: readonly string[]): BlockList {
  const cacheKey = cidrs.join(',');
  let list = lists.get(cacheKey);
  if (!list) {
    list = new BlockList();
    for (const cidr of cidrs) {
      const [network = '', prefix = ''] = cidr.split('/');
      list.addSubnet(network, Number(prefix), isIPv4(network) ? 'ipv4' : 'ipv6');
    }
    lists.set(cacheKey, list);
  }
  return list;
}

function isTrusted(address: Address, cidrs: readonly string[]): boolean {
  if (!cidrs.length) return false;
  const list = trustedList(cidrs);
  return address.family === 'ipv4' ? list.check(address.v4!, 'ipv4') : list.check(bucketAddress(address), 'ipv6');
}

const bucketAddress = (address: Address) => address.groups!.map((g) => g.toString(16)).join(':');

export function clientBucket(input: {
  readonly peer: string | undefined;
  readonly forwardedFor: string | undefined;
  readonly trusted: readonly string[];
}): string {
  const peer = parseAddress(input.peer);
  if (!peer) return UNKNOWN_CLIENT;
  if (!isTrusted(peer, input.trusted)) return bucketOf(peer);
  const chain = (input.forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chain.length) return bucketOf(peer);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const hop = parseAddress(chain[i]);
    if (!hop) return UNKNOWN_CLIENT;
    if (!isTrusted(hop, input.trusted)) return bucketOf(hop);
  }
  return bucketOf(parseAddress(chain[0])!);
}

/** 从 Hono 请求取限频桶：套接字对端来自 @hono/node-server 的 env.incoming（测试里可传同形状的 env）。 */
export function requestBucket(c: Context, trusted: readonly string[]): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return clientBucket({ peer: socket?.remoteAddress, forwardedFor: c.req.header('x-forwarded-for'), trusted });
}
