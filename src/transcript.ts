/** Normalizes OpenCode deltas and cumulative snapshots by provider message/part identity. */
export interface TranscriptChunk {
  kind: 'message' | 'provider_reasoning'; message: string;
  data: { sessionId: string; messageId: string; partId: string; role: string; contentType: string; operation: 'append' | 'replace' };
}
interface PartState { text: string; emitted: string; type?: string; messageId: string; recovering?: boolean; }
export class Transcript {
  private roles = new Map<string, string>(); private parts = new Map<string, PartState>();
  readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }
  accept(event: any): TranscriptChunk[] {
    const properties = event?.properties || {};
    const session = properties.sessionID || properties.info?.sessionID || properties.part?.sessionID;
    if (session && session !== this.sessionId) return [];
    if (event.type === 'message.updated') {
      const info = properties.info;
      if (info?.id && info.role) this.roles.set(info.id, info.role);
      return [];
    }
    if (!['message.part.updated', 'message.part.delta'].includes(event.type)) return [];
    const snapshot = event.type === 'message.part.updated'; const part = properties.part || properties;
    const messageId = part.messageID || properties.messageID; const partId = part.id || properties.partID;
    if (!messageId || !partId) return [];
    const key = `${messageId}:${partId}`;
    const state: PartState = this.parts.get(key) || {text:'',emitted:'',messageId};
    if (part.type) state.type = part.type;
    if (snapshot) {
      if(typeof part.text==='string'){
        if(state.recovering && state.text.startsWith(part.text) && part.text.length<state.text.length)return [];
        state.text=part.text;state.recovering=false;
      }
    }
    else if (!state.recovering && (!properties.field || properties.field === 'text') && typeof properties.delta === 'string') state.text += properties.delta;
    this.parts.set(key,state);
    if (!['text','reasoning'].includes(state.type || '') || state.text === state.emitted) return [];
    const operation = state.text.startsWith(state.emitted) ? 'append' : 'replace';
    const message = operation === 'append' ? state.text.slice(state.emitted.length) : state.text;
    state.emitted = state.text;
    return [{kind: state.type === 'reasoning' ? 'provider_reasoning' : 'message',message,data:{sessionId:this.sessionId,messageId,partId,role:this.roles.get(messageId) || 'unknown',contentType:state.type!,operation}}];
  }
  recover(messages: unknown): TranscriptChunk[] {
    if(!Array.isArray(messages))throw new Error('OpenCode recovery did not return a message list');
    const present=new Set(messages.map(message=>message?.info?.id));
    if([...this.parts.values()].some(part=>part.emitted && !present.has(part.messageId)))throw new Error('OpenCode recovery is missing earlier message state');
    const chunks=this.reconcile(messages);
    for(const part of this.parts.values())if(part.emitted)part.recovering=true;
    return chunks;
  }
  reconcile(messages: unknown): TranscriptChunk[] {
    if (!Array.isArray(messages)) throw new Error('OpenCode recovery did not return a message list');
    const chunks: TranscriptChunk[] = [];
    for (const message of messages) {
      if (!message?.info?.id || !Array.isArray(message.parts)) throw new Error('OpenCode recovery returned an incomplete message list');
      this.accept({type:'message.updated',properties:{info:message.info}});
      for (const part of message.parts) chunks.push(...this.accept({type:'message.part.updated',properties:{part:{...part,messageID:part.messageID || message.info.id,sessionID:part.sessionID || message.info.sessionID}}}));
    }
    return chunks;
  }
}
