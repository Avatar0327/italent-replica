/**
 * 关键安全事件（F-076 设计 §5.4；DEC-377④）：只增不改的 survey360_security_events，与引发它的写入在同一事务。
 * 字段都不含秘密：不得写序列号、密码、令牌明文，也不得写摘要全文或 IP 原值；key_prefix / ip_prefix 只取 HMAC 前 8 位。
 */
import { survey360SecurityEvents, type Tx } from '@italent/db';

export type SecurityEventKind =
  | 'login_success'
  | 'logout'
  | 'lock'
  | 'unlock'
  | 'credential_issued'
  | 'credential_reissued'
  | 'credential_revoked'
  | 'key_rotated'
  | 'key_retired';

export interface SecurityEvent {
  readonly tenantId: string;
  readonly kind: SecurityEventKind;
  readonly occurredAt: Date;
  readonly linkId?: string;
  readonly oldLinkId?: string;
  readonly activityId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly credentialKeyVersion?: number;
  readonly compromised?: boolean;
  readonly scope?: string;
  readonly keyPrefix?: string;
  readonly ipPrefix?: string;
  /** 只放计数、时间等非秘密值。 */
  readonly detail?: Record<string, string | number | boolean | null>;
}

export async function recordSecurityEvent(tx: Tx, event: SecurityEvent): Promise<void> {
  await tx.insert(survey360SecurityEvents).values({
    tenantId: event.tenantId,
    kind: event.kind,
    occurredAt: event.occurredAt,
    linkId: event.linkId ?? null,
    oldLinkId: event.oldLinkId ?? null,
    activityId: event.activityId ?? null,
    sessionId: event.sessionId ?? null,
    runId: event.runId ?? null,
    credentialKeyVersion: event.credentialKeyVersion ?? null,
    compromised: event.compromised ?? null,
    scope: event.scope ?? null,
    keyPrefix: event.keyPrefix ?? null,
    ipPrefix: event.ipPrefix ?? null,
    detail: event.detail ?? {},
  });
}
