// A tiny Agent Client Protocol agent for testing Still's side chat without a
// model: it streams a reply, reports a Still tool step, asks permission once
// and offers a model choice. Used by check-chat.js.
const readline = require('node:readline');

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1000;
const pending = new Map();
let model = 'fast';
let cancelled = false;

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function options() {
  return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'fast', name: 'Fast model' }, { value: 'deep', name: 'Deep model' }] }];
}

async function prompt(id, { sessionId, prompt: blocks }) {
  cancelled = false;
  const said = blocks.map((block) => block.text).join('\n');
  const page = (said.match(/The page in front of the user: (.*)/) || [])[1] || 'no page';
  const chunks = ['Looking at ', 'the page ', 'first.'];
  for (const text of chunks) { update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } }); await wait(60); }
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'other', title: 'mcp.still.snapshot', status: 'in_progress', rawInput: { server: 'still', tool: 'snapshot', arguments: { tab: 1 } } });
  await wait(250);
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  const answer = await ask('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 't2', title: 'mcp.still.click', rawInput: { server: 'still', tool: 'click', arguments: { ref: 'e3' } } },
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
  });
  if (cancelled) return send({ id, result: { stopReason: 'cancelled' } });
  const allowed = answer?.outcome?.optionId === 'allow';
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'other', title: 'mcp.still.click', status: allowed ? 'completed' : 'failed', rawInput: { server: 'still', tool: 'click' } });
  const reply = `Done with **${model}**.\n\n- Page: ${page}\n- Click: ${allowed ? 'allowed' : 'rejected'}\n\nSee https://example.com/result for more.`;
  for (const text of reply.match(/.{1,12}/gs)) { update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text } }); await wait(15); }
  send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
  const { id, method, params = {} } = message;
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '1' }, agentCapabilities: {} } });
  else if (method === 'session/new') send({ id, result: { sessionId: 's1', configOptions: options() } });
  else if (method === 'session/set_config_option') { model = params.value; send({ id, result: { configOptions: options() } }); }
  else if (method === 'session/prompt') prompt(id, params);
  else if (method === 'session/cancel') { cancelled = true; for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } }); pending.clear(); }
  else if (method === 'session/close') send({ id, result: {} });
  else if (id !== undefined) send({ id, error: { code: -32601, message: `No ${method}` } });
});
