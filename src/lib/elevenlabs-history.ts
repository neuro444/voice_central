// Adapt stored ElevenLabs payloads without inferring orders or monetary costs.
export interface ElevenLabsCall {
  conversation_id: string;
  status?: string;
  metadata?: { start_time_unix_secs?: number; call_duration_secs?: number; phone_call?: { external_number?: string } };
  analysis?: { transcript_summary?: string; data_collection?: Record<string, { value?: unknown }>; data_collection_results?: Record<string, { value?: unknown }> };
  transcript?: { role: string; message?: string | null; time_in_call_secs?: number; tool_calls?: unknown[]; tool_results?: unknown[] }[];
}
export const historyId = (id: string) => `elevenlabs:${id}`;
export function mapElevenLabsCall(call: ElevenLabsCall) {
  const fields = call.analysis?.data_collection_results || call.analysis?.data_collection || {};
  const field = (key: string) => typeof fields[key]?.value === 'string' ? fields[key].value as string : '';
  return {
    id: historyId(call.conversation_id), phone: call.metadata?.phone_call?.external_number || field('phone'),
    name: field('customer_name') || 'Unknown caller', channel: 'phone', state: 'done',
    intent: `ElevenLabs · ${call.status || 'unknown'}`,
    last_message: call.analysis?.transcript_summary || call.transcript?.filter(t => t.message).at(-1)?.message || '',
    last_message_at: new Date((call.metadata?.start_time_unix_secs || 0) * 1000).toISOString(),
  };
}
export function mapElevenLabsMessages(call: ElevenLabsCall) {
  return (call.transcript || []).map((turn, index) => ({
    id: `${historyId(call.conversation_id)}:${index}`,
    direction: turn.role === 'user' ? 'inbound' as const : 'outbound' as const,
    body: [turn.message, turn.tool_calls?.length ? `Tool calls: ${JSON.stringify(turn.tool_calls)}` : '',
      turn.tool_results?.length ? `Tool results: ${JSON.stringify(turn.tool_results)}` : ''].filter(Boolean).join('\n'),
    media_type: 'text',
    created_at: new Date(((call.metadata?.start_time_unix_secs || 0) + (turn.time_in_call_secs || 0)) * 1000).toISOString(),
  })).filter(turn => turn.body);
}
export async function fetchSavedHistory(fetcher: typeof fetch, base: string): Promise<ElevenLabsCall[]> {
  const calls = new Map<string, ElevenLabsCall>();
  let offset = 0;
  while (true) {
    const response = await fetcher(`${base}/elevenlabs/saved?page_size=100&offset=${offset}`);
    if (!response.ok) throw new Error('ElevenLabs history unavailable');
    const page = await response.json();
    if (!Array.isArray(page.conversations)) throw new Error('Invalid history response');
    for (const call of page.conversations) calls.set(call.conversation_id, call);
    if (!page.has_more) break;
    if (!Number.isInteger(page.next_offset) || page.next_offset <= offset) throw new Error('Invalid history pagination');
    offset = page.next_offset;
  }
  return Array.from(calls.values());
}
