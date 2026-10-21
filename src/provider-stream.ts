import { providerError, type ProviderError } from './provider-health.ts';

export interface ProviderFrame { text: string; data?: any; event?: string; done?: boolean; invalid?: boolean; }
/** Incremental UTF-8 decoder and SSE event framing, including CRLF and multiline data. */
export async function* providerFrames(response: Response): AsyncGenerator<ProviderFrame> {
  const sse = /text\/event-stream/i.test(response.headers.get('content-type') || '');
  if (!response.body) { yield {text:'',invalid:true}; return; }
  const decoder = new TextDecoder('utf-8', {fatal:true}); let buffer = '';
  const parse = (text: string): ProviderFrame => {
    if (!sse) { try {return {text,data:JSON.parse(text)};} catch {return {text,invalid:true};} }
    let event: string | undefined; const data: string[] = [];
    for(const line of text.split(/\r?\n/)) {
      if(line.startsWith(':') || line === '')continue;
      const colon=line.indexOf(':');const field=colon<0?line:line.slice(0,colon);let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
      if(field==='event')event=value;if(field==='data')data.push(value);
    }
    const value=data.join('\n'); if(!data.length)return {text,event};if(value.trim()==='[DONE]')return {text,event,done:true};
    try {return {text,event,data:JSON.parse(value)};} catch {return {text,event,invalid:true};}
  };
  const reader=response.body.getReader();let eof=false;
  try {for (;;) {
    const chunk=await reader.read();if(chunk.done){eof=true;break;}
    buffer += decoder.decode(chunk.value,{stream:true});
    if(buffer.length > 4_000_000)throw new Error('Provider response frame exceeded the supported size');
    if(sse) {
      let match: RegExpExecArray | null;
      while((match=/\r?\n\r?\n/.exec(buffer))) {
        const end=match.index+match[0].length;const text=buffer.slice(0,end);buffer=buffer.slice(end);yield parse(text);
      }
    }
  }
  } finally {if(!eof)await reader.cancel().catch(()=>{});reader.releaseLock();}
  buffer += decoder.decode();
  if(buffer.trim())yield parse(buffer);
}
export function frameOutput(data: any): {meaningful:boolean; usable:boolean; finish:boolean} {
  let meaningful=false,usable=false,finish=false;
  for(const choice of Array.isArray(data?.choices) ? data.choices : []) {
    finish ||= typeof choice?.finish_reason === 'string';
    const delta=choice?.delta || choice?.message || {};
    const text=typeof delta.content==='string' ? delta.content.length>0 : Array.isArray(delta.content) && delta.content.length>0;
    const tool=Array.isArray(delta.tool_calls) && delta.tool_calls.length>0 || !!delta.function_call && typeof delta.function_call==='object' && Object.keys(delta.function_call).length>0;
    const reasoning=typeof delta.reasoning_content==='string' && delta.reasoning_content.length>0 || typeof delta.reasoning==='string' && delta.reasoning.length>0;
    usable ||= text || tool;meaningful ||= usable || reasoning;
  }
  return {meaningful,usable,finish};
}
export function frameError(frame: ProviderFrame, httpStatus: number): ProviderError | undefined {
  if(httpStatus>=400)return providerError(frame.data,httpStatus,frame.event);
  if(Array.isArray(frame.data?.choices) && frame.data.choices.some((choice:any)=>choice?.finish_reason==='error'))return providerError({error:{code:500}},httpStatus);
  if(frame.invalid)return {kind:'stream_interrupted',type:'invalid_provider_frame',message:'Model provider returned an invalid response frame.',retryable:true};
  return providerError(frame.data,httpStatus,frame.event);
}
