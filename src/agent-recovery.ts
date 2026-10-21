import { providerError } from './provider-health.ts';

/** Stable fallback identity when OpenCode reports a model error without a gateway receipt. */
export function agentProviderFailure(error: unknown): { signature: string; message: string } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = 'OpenCode/model error: ';
  if (!message.startsWith(prefix)) return;
  let detail: any;
  try { detail = JSON.parse(message.slice(prefix.length)); } catch { detail = { message: message.slice(prefix.length) }; }
  let nested = detail?.data?.message ?? detail?.message;
  if (typeof nested === 'string') { try { nested = JSON.parse(nested); } catch {} }
  const code = nested?.code ?? detail?.data?.statusCode ?? detail?.code;
  const type = nested?.type ?? detail?.type;
  const status = typeof code === 'number' && Number.isSafeInteger(code) && code >= 400 && code <= 599 ? code : 500;
  // Only canonical protocol fields determine recurrence. Arbitrary echoed messages can contain private
  // input or changing request IDs; they must neither enter checkpoint metadata nor evade the breaker.
  const safe = providerError({ error: { code, type } }, status)!;
  return { signature: JSON.stringify([safe.kind, safe.code, safe.type]), message: safe.message };
}
