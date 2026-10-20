import type { Config } from './types.ts';
export function providerRetrySeconds(headers: Headers | undefined, attempt: number, now = Date.now()) {
  const header=headers?.get('retry-after')?.trim();
  if(header) {
    const seconds=Number(header); if(Number.isFinite(seconds) && seconds>=0)return Math.max(1,seconds);
    const date=Date.parse(header); if(Number.isFinite(date))return Math.max(1,Math.ceil((date-now)/1000));
  }
  return Math.min(30,2**Math.min(attempt+1,5));
}
/** Explicit NVIDIA settings make a saved run reproducible without inferred provider defaults. */
export function providerBody(input: Record<string,any>, config: Config): Record<string,any> {
  const body: Record<string,any>={...input,max_tokens:Math.min(Number(input.max_tokens)||config.modelMaxOutput,config.modelMaxOutput),temperature:config.modelTemperature,top_p:config.modelTopP};
  if (typeof body.model==='string' && /^nvidia\/nemotron-/.test(body.model)) {
    body.chat_template_kwargs={enable_thinking:config.modelThinking};
    if(body.model==='nvidia/nemotron-3.5-lightning-30b-a3b' && config.modelThinking)body.reasoning_budget=Math.min(config.reasoningBudget,body.max_tokens);
  }
  return body;
}
