import type { Config } from './types.ts';
export function providerRetrySeconds(headers: Headers | undefined, attempt: number, now = Date.now()) {
  const header=headers?.get('retry-after')?.trim();
  if(header) {
    const seconds=Number(header); if(Number.isFinite(seconds) && seconds>=0)return Math.max(1,seconds);
    const date=Date.parse(header); if(Number.isFinite(date))return Math.max(1,Math.ceil((date-now)/1000));
  }
  return Math.min(30,2**Math.min(attempt+1,5));
}
export type ModelTurnPurpose = 'discovery' | 'reproduction' | 'review' | 'patching' | 'locked' | 'format';
const ultra = 'nvidia/nemotron-3-ultra-550b-a55b';
const lightning = 'nvidia/nemotron-3.5-lightning-30b-a3b';
/** Only this observed NVIDIA runner error permits omitting a configured request parameter. */
export function rejectsReasoningBudgetError(value: any, status: number, body: Record<string, any>): boolean {
  if (![200,400].includes(status) || ![ultra, lightning].includes(body.model) || typeof body.reasoning_budget !== 'number') return false;
  return value?.error?.message === 'ValueError: thinking_token_budget is not yet supported by the V2 model runner. Run vLLM with VLLM_USE_V2_MODEL_RUNNER=0 to use thinking_token_budget.';
}
export async function rejectsReasoningBudget(response: Response, body: Record<string, any>): Promise<boolean> {
  return rejectsReasoningBudgetError(await response.clone().json().catch(() => undefined), response.status, body);
}
/** Explicit controller policy. Purpose is supplied by the trusted turn, never read from the request body. */
export function providerBody(input: Record<string,any>, config: Config, purpose: ModelTurnPurpose = 'reproduction'): Record<string,any> {
  const body: Record<string,any> = { ...input, max_tokens: Math.min(Number(input.max_tokens) || config.modelMaxOutput, config.modelMaxOutput), temperature: config.modelTemperature, top_p: config.modelTopP };
  if (body.model !== ultra && body.model !== lightning) {
    if (typeof body.model === 'string' && /^nvidia\/nemotron-/.test(body.model)) body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: config.modelThinking };
    return body;
  }
  if (input.max_tokens !== undefined && (typeof input.max_tokens !== 'number' || !Number.isSafeInteger(input.max_tokens) || input.max_tokens <= 0)) throw new Error('max_tokens must be a positive finite integer');
  const replyOnly = purpose === 'format' || purpose === 'locked';
  const discovery = purpose === 'discovery';
  // Both NVIDIA endpoints document a 32K per-request completion cap. It is independent of context capacity.
  body.max_tokens = Math.min(input.max_tokens ?? config.modelMaxOutput, config.modelMaxOutput, 32768, replyOnly ? 2048 : discovery ? 8192 : 24576);
  // Request 2K for the final answer/tool call; enforcement depends on endpoint support for reasoning_budget.
  const room = Math.max(0, body.max_tokens - 2048);
  const thinking = config.modelThinking && !replyOnly && (room > 0 || config.reasoningBudget === -1 && config.allowUnboundedReasoning);
  const kwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object' && !Array.isArray(body.chat_template_kwargs) ? { ...body.chat_template_kwargs } : {};
  for (const key of ['enable_thinking', 'medium_effort', 'reasoning_effort', 'reasoning_budget']) delete kwargs[key];
  // Alternate client-supplied thinking APIs must not bypass the controller's policy.
  for (const key of ['thinking', 'reasoning', 'reasoning_effort', 'reasoning_budget', 'purpose', 'turnPurpose']) delete body[key];
  kwargs.enable_thinking = thinking;
  if (body.model === ultra) {
    kwargs.medium_effort = thinking && discovery;
    body.reasoning_effort = !thinking ? 'none' : discovery ? 'medium' : 'high';
  }
  body.chat_template_kwargs = kwargs;
  if (thinking) body.reasoning_budget = config.reasoningBudget === -1 && config.allowUnboundedReasoning ? -1 : Math.min(config.reasoningBudget, discovery ? 4096 : 16384, room);
  return body;
}
