import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** Protocol-only metadata: never store arbitrary provider message text or response bodies. */
export interface ProviderFailure {
  requestId: string;
  kind: 'rate_limit' | 'authentication' | 'invalid_request' | 'provider_error' | 'stream_interrupted';
  httpStatus?: number;
  code?: string | number;
  type?: string;
  message: string;
  retryable: boolean;
  meaningfulOutput: boolean;
  usableOutput: boolean;
  at: string;
  signature: string;
  consecutiveFailures: number;
  circuitOpen: boolean;
}
export interface ProviderAttemptRecord {
  attempt: number; startedAt: string; finishedAt: string; latencyMs: number; httpStatus?: number;
  requestId?: string; retryOwner: 'gateway'; retryAfterSeconds?: number; rateLimit?: Record<string, string>;
  error?: ProviderFailure;
}
export type ProviderError = Pick<ProviderFailure, 'kind' | 'code' | 'type' | 'message' | 'retryable'>;
const safeTypes = new Set(['server_error', 'internal_server_error', 'rate_limit_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'Bad Request']);
const safeCodes = new Set(['rate_limit_exceeded', 'invalid_api_key', 'invalid_request_error', 'context_length_exceeded', 'model_not_found', 'unsupported_parameter']);

export function providerError(value: any, httpStatus: number, eventType?: string): ProviderError | undefined {
  // OpenAI-compatible providers also send top-level errors. Require protocol fields,
  // never inspect ordinary assistant content for error-shaped text.
  const topLevelError = value && typeof value === 'object' && !('choices' in value) && typeof value.message === 'string' && safeTypes.has(value.type)
    && (typeof value.code === 'number' && Number.isSafeInteger(value.code) && value.code >= 400 && value.code <= 599 || typeof value.code === 'string' && safeCodes.has(value.code));
  const envelope = value?.error ?? (eventType === 'error' || value?.object === 'error' || topLevelError ? value : undefined);
  if (envelope === undefined && httpStatus < 400 && eventType !== 'error') return undefined;
  const raw = envelope && typeof envelope === 'object' ? envelope : {};
  const code = typeof raw.code === 'number' && Number.isSafeInteger(raw.code) && raw.code >= 100 && raw.code <= 599 ? raw.code
    : typeof raw.code === 'string' && safeCodes.has(raw.code) ? raw.code : undefined;
  const status = typeof code === 'number' ? code : httpStatus;
  const type = typeof raw.type === 'string' && safeTypes.has(raw.type) ? raw.type : undefined;
  const kind = status === 429 ? 'rate_limit' : [401,403].includes(status) ? 'authentication' : status >= 400 && status < 500 ? 'invalid_request' : 'provider_error';
  const message = kind === 'rate_limit' ? 'Model provider rate limit reached.' : kind === 'authentication' ? 'Model provider rejected the credentials or access.'
    : kind === 'invalid_request' ? 'Model provider rejected the request parameters.' : 'Model provider returned an internal error.';
  return { kind, ...(code === undefined ? {} : {code}), ...(type ? {type} : {}), message, retryable: kind === 'rate_limit' || kind === 'provider_error' };
}
export function interruptedProviderError(): ProviderError {
  return {kind:'stream_interrupted',type:'stream_interrupted',message:'Model provider stream ended without a complete generation.',retryable:true};
}
export function recordProviderFailure(previous: ProviderFailure | undefined, error: ProviderError, details: {requestId:string; httpStatus?:number; meaningfulOutput:boolean; usableOutput:boolean; identity:string}): ProviderFailure {
  const signature = createHash('sha256').update(JSON.stringify([details.identity,error.kind,error.code,error.type])).digest('hex');
  const consecutiveFailures = previous?.signature === signature ? previous.consecutiveFailures + 1 : 1;
  const {identity: _identity, ...metadata}=details;
  return {...error,...metadata,at:new Date().toISOString(),signature,consecutiveFailures,circuitOpen:details.meaningfulOutput || !error.retryable || consecutiveFailures >= 3};
}
/** An account's known cooldown also applies to a new SDK request or another active connection. */
export class ProviderCooldown {
  private deadlines = new Map<string, number>();
  defer(key: string, seconds: number) { this.deadlines.set(key, Math.max(this.deadlines.get(key) || 0, Date.now() + seconds * 1000)); }
  async wait(key: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted(); const remaining = (this.deadlines.get(key) || 0) - Date.now();
      if (remaining <= 0) return;
      await sleep(remaining, undefined, {signal});
    }
  }
}
export function providerAttemptHeaders(headers: Headers, secret: string): Pick<ProviderAttemptRecord, 'requestId' | 'rateLimit'> {
  const id = headers.get('nvcf-reqid') || headers.get('x-request-id') || headers.get('request-id') || headers.get('nvidia-request-id');
  const requestId = id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) && !id.includes(secret) ? id : undefined;
  const rateLimit: Record<string,string> = {};
  for (const name of ['retry-after','x-ratelimit-limit-requests','x-ratelimit-remaining-requests','x-ratelimit-reset-requests','x-ratelimit-limit-tokens','x-ratelimit-remaining-tokens','x-ratelimit-reset-tokens']) {
    const value = headers.get(name);
    // Values are numeric/duration metadata or HTTP dates, never arbitrary echoed strings.
    if (!value || value.includes(secret))continue;
    if (/^\d+(?:\.\d+)?(?:ms|s|m|h)?$/.test(value))rateLimit[name]=value.slice(0,128);
    else if(name === 'retry-after' && Number.isFinite(Date.parse(value)))rateLimit[name]=new Date(Date.parse(value)).toUTCString();
  }
  return {...(requestId ? {requestId} : {}),...(Object.keys(rateLimit).length ? {rateLimit} : {})};
}
