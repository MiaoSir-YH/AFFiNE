import type {
  LlmRequest,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolCallbackRequest,
  LlmToolCallbackResponse,
  LlmToolLoopStreamEvent,
} from '../../../native';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const TOOL_NAMESPACE = 'affine';

type JsonObject = Record<string, unknown>;
type Usage = LlmStructuredResponse['usage'];
type ToolCall = Extract<LlmToolLoopStreamEvent, { type: 'tool_call' }>;

export interface ChatGPTResponsesOptions {
  getAccessToken: () => Promise<string>;
  executeTool?: (
    request: LlmToolCallbackRequest
  ) => Promise<LlmToolCallbackResponse>;
  signal?: AbortSignal;
  maxSteps?: number;
  fetch?: typeof globalThis.fetch;
}

export class ChatGPTResponsesError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ChatGPTResponsesError';
  }
}

function object(value: unknown): JsonObject | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return undefined;
}

function errorCode(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
    ? value
    : undefined;
}

function wireOutput(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

function dataUrl(data: string, mediaType: unknown) {
  return data.startsWith('data:') || typeof mediaType !== 'string'
    ? data
    : `data:${mediaType};base64,${data}`;
}

function inputAttachment(kind: 'image' | 'file', value: unknown): JsonObject {
  const source = object(value);
  const url =
    typeof value === 'string'
      ? value
      : (source?.url ??
        source?.file_url ??
        object(source?.image_url)?.url ??
        source?.image_url);
  const data = source?.data ?? source?.file_data;
  const fileId = source?.file_id ?? source?.file_handle;
  const mediaType = source?.media_type ?? source?.mime_type ?? source?.mimeType;

  if (kind === 'image') {
    const imageUrl =
      typeof data === 'string' ? dataUrl(data, mediaType ?? 'image/png') : url;
    if (typeof imageUrl !== 'string' && typeof fileId !== 'string') {
      throw new ChatGPTResponsesError(
        'ChatGPT image input is missing its data'
      );
    }
    return {
      type: 'input_image',
      detail: source?.detail ?? 'auto',
      ...(typeof imageUrl === 'string'
        ? { image_url: imageUrl }
        : { file_id: fileId }),
    };
  }

  const filename = source?.file_name ?? source?.filename;
  if (typeof data === 'string') {
    return {
      type: 'input_file',
      file_data: dataUrl(data, mediaType),
      ...(typeof filename === 'string' ? { filename } : {}),
    };
  }
  if (typeof url === 'string' || typeof fileId === 'string') {
    return {
      type: 'input_file',
      ...(typeof url === 'string' ? { file_url: url } : { file_id: fileId }),
    };
  }
  throw new ChatGPTResponsesError('ChatGPT file input is missing its data');
}

function inputMessages(messages: LlmRequest['messages']): JsonObject[] {
  return messages.flatMap(({ role, content }) => {
    const parts: JsonObject[] = [];
    const toolItems: JsonObject[] = [];
    for (const value of content) {
      const part = object(value);
      switch (part?.type) {
        case 'text':
          parts.push({ type: 'input_text', text: part.text });
          break;
        case 'image':
        case 'file':
          parts.push(inputAttachment(part.type, part.source));
          break;
        case 'tool_call':
          toolItems.push({
            type: 'function_call',
            namespace: TOOL_NAMESPACE,
            call_id: part.call_id,
            name: part.name,
            arguments: wireOutput(part.arguments),
          });
          break;
        case 'tool_result':
          toolItems.push({
            type: 'function_call_output',
            call_id: part.call_id,
            output: wireOutput(part.output),
          });
          break;
        case 'reasoning':
          // Only the encrypted reasoning items returned by Responses can be
          // replayed. Canonical reasoning text is for display.
          break;
        default:
          throw new ChatGPTResponsesError(
            'Unsupported ChatGPT message content'
          );
      }
    }
    if (parts.length) {
      const textOnly = parts.every(part => part.type === 'input_text');
      toolItems.unshift({
        role: role === 'system' ? 'developer' : role,
        content: textOnly ? parts.map(part => part.text).join('') : parts,
      });
    }
    return toolItems;
  });
}

function responsesBody(
  request: LlmRequest,
  input: JsonObject[],
  strict: boolean
) {
  const reasoning = request.reasoning;
  const tools = request.tools?.length
    ? [
        {
          type: 'namespace',
          name: TOOL_NAMESPACE,
          description: 'Tools provided by AFFiNE',
          tools: request.tools.map(tool => ({
            ...tool,
            type: 'function',
            strict: false,
          })),
        },
      ]
    : undefined;
  return {
    model: request.model,
    input,
    store: false,
    stream: true,
    reasoning: reasoning
      ? { effort: reasoning.effort, summary: reasoning.summary }
      : undefined,
    tools,
    tool_choice: tools
      ? typeof request.toolChoice === 'object'
        ? { type: 'function', name: request.toolChoice.name }
        : request.toolChoice
      : undefined,
    text: request.responseSchema
      ? {
          format: {
            type: 'json_schema',
            name: 'affine_response',
            schema: request.responseSchema,
            strict,
          },
        }
      : undefined,
  };
}

async function* readResponseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffer.search(/[\r\n]/)) !== -1) {
        if (
          !done &&
          buffer[boundary] === '\r' &&
          boundary === buffer.length - 1
        ) {
          break;
        }
        const line = buffer.slice(0, boundary);
        const crlf = buffer.slice(boundary, boundary + 2) === '\r\n';
        buffer = buffer.slice(boundary + (crlf ? 2 : 1));
        if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (!line && data.length) {
          const payload = data.join('\n');
          data = [];
          if (payload === '[DONE]') return;
          let event: JsonObject | undefined;
          try {
            event = object(JSON.parse(payload));
          } catch {
            // Do not include the raw stream, which can contain user content.
          }
          if (!event)
            throw new ChatGPTResponsesError('Invalid ChatGPT stream event');
          yield event;
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function responseOutput(response: JsonObject): JsonObject[] {
  if (!Array.isArray(response.output)) return [];
  return response.output.map(object).filter(item => item !== undefined);
}

function outputContent(output: JsonObject[]) {
  return output
    .flatMap(item => (Array.isArray(item.content) ? item.content : []))
    .map(object)
    .filter(part => part !== undefined);
}

function startEvent(response: JsonObject): LlmToolLoopStreamEvent {
  return {
    type: 'message_start',
    id: typeof response.id === 'string' ? response.id : undefined,
    model: typeof response.model === 'string' ? response.model : undefined,
  };
}

function toolCallEvent(item: JsonObject): ToolCall {
  if (typeof item.call_id !== 'string' || typeof item.name !== 'string') {
    throw new ChatGPTResponsesError('Invalid ChatGPT tool call');
  }
  const raw = typeof item.arguments === 'string' ? item.arguments : '';
  let args: JsonObject | undefined;
  try {
    args = object(JSON.parse(raw));
  } catch {
    // The existing tool callback handles malformed arguments as a tool error.
  }
  return {
    type: 'tool_call',
    call_id: item.call_id,
    name: item.name,
    arguments: args ?? {},
    arguments_text: raw,
    ...(args ? {} : { arguments_error: 'Expected a JSON object' }),
  };
}

async function* requestResponse(
  request: LlmRequest,
  input: JsonObject[],
  options: ChatGPTResponsesOptions,
  strict: boolean
): AsyncGenerator<LlmToolLoopStreamEvent, JsonObject> {
  options.signal?.throwIfAborted();
  const token = await options.getAccessToken();
  const fetchResponse = options.fetch ?? globalThis.fetch;
  const response = await fetchResponse(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(responsesBody(request, input, strict)),
    signal: options.signal,
    redirect: 'error',
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const code = errorCode(object(object(payload)?.error)?.code);
    throw new ChatGPTResponsesError(
      `ChatGPT request failed (HTTP ${response.status}${code ? `, ${code}` : ''})`,
      code,
      response.status
    );
  }
  if (!response.body)
    throw new ChatGPTResponsesError('ChatGPT returned an empty stream');

  let textReceived = false;
  let started = false;
  for await (const event of readResponseEvents(response.body)) {
    switch (event.type) {
      case 'response.created': {
        const created = object(event.response);
        if (created) {
          started = true;
          yield startEvent(created);
        }
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (typeof event.delta === 'string') {
          textReceived = true;
          yield { type: 'text_delta', text: event.delta };
        }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event.delta === 'string') {
          yield { type: 'reasoning_delta', text: event.delta };
        }
        break;
      case 'response.completed': {
        const completed = object(event.response);
        if (!completed)
          throw new ChatGPTResponsesError('Invalid ChatGPT completion');
        if (!started) yield startEvent(completed);
        if (!textReceived) {
          const text = outputContent(responseOutput(completed))
            .map(part => {
              if (part.type === 'output_text') return part.text;
              if (part.type === 'refusal') return part.refusal;
              return undefined;
            })
            .filter(part => typeof part === 'string')
            .join('');
          if (text) yield { type: 'text_delta', text };
        }
        return completed;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'error': {
        const result = object(event.response);
        const code =
          errorCode(object(result?.error)?.code) ??
          errorCode(object(result?.incomplete_details)?.reason) ??
          errorCode(object(event.error)?.code) ??
          errorCode(event.code);
        throw new ChatGPTResponsesError(
          `ChatGPT stream ${event.type === 'response.incomplete' ? 'was incomplete' : 'failed'}${code ? ` (${code})` : ''}`,
          code
        );
      }
    }
  }
  throw new ChatGPTResponsesError('ChatGPT stream ended before completion');
}

function addUsage(usage: Usage, value: unknown) {
  const current = object(value);
  if (!current) return;
  const cached = object(current.input_tokens_details)?.cached_tokens;
  if (typeof current.input_tokens === 'number')
    usage.prompt_tokens += current.input_tokens;
  if (typeof current.output_tokens === 'number')
    usage.completion_tokens += current.output_tokens;
  if (typeof current.total_tokens === 'number')
    usage.total_tokens += current.total_tokens;
  if (typeof cached === 'number')
    usage.cached_tokens = (usage.cached_tokens ?? 0) + cached;
}

async function* runResponses(
  request: LlmRequest,
  options: ChatGPTResponsesOptions,
  strict: boolean
): AsyncGenerator<LlmToolLoopStreamEvent> {
  const input = inputMessages(request.messages);
  const usage: Usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const processedCalls = new Set<string>();
  const citedUrls = new Set<string>();
  const maxSteps = options.maxSteps ?? 20;

  for (let step = 0; step < maxSteps; step++) {
    const response = yield* requestResponse(request, input, options, strict);
    addUsage(usage, response.usage);
    const output = responseOutput(response);
    for (const { annotations } of outputContent(output)) {
      if (!Array.isArray(annotations)) continue;
      for (const value of annotations) {
        const annotation = object(value);
        const url = annotation?.url;
        if (
          annotation?.type === 'url_citation' &&
          typeof url === 'string' &&
          !citedUrls.has(url)
        ) {
          citedUrls.add(url);
          yield { type: 'citation', index: citedUrls.size, url };
        }
      }
    }

    const calls = output.filter(item => item.type === 'function_call');
    if (!calls.length) {
      yield { type: 'usage', usage };
      yield { type: 'done', finish_reason: 'stop', usage };
      return;
    }
    const executeTool = options.executeTool;
    if (!executeTool)
      throw new ChatGPTResponsesError('ChatGPT requested an unavailable tool');
    if (step + 1 === maxSteps) break;

    // The subscription endpoint is stateless. Echo the returned items before
    // adding tool output, including the opaque encrypted reasoning items.
    input.push(...output);
    for (const item of calls) {
      options.signal?.throwIfAborted();
      const call = toolCallEvent(item);
      if (processedCalls.has(call.call_id)) {
        throw new ChatGPTResponsesError(
          'ChatGPT repeated a previously executed tool call'
        );
      }
      processedCalls.add(call.call_id);
      yield call;
      const result = await executeTool({
        callId: call.call_id,
        name: call.name,
        args: call.arguments,
        rawArgumentsText: call.arguments_text,
        argumentParseError: call.arguments_error,
      });
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: wireOutput(result.output),
      });
      yield {
        ...call,
        type: 'tool_result',
        output: result.output,
        is_error: result.isError,
      };
    }
  }
  throw new ChatGPTResponsesError('ChatGPT exceeded the tool call limit');
}

export function streamChatGPTResponses(
  request: LlmRequest,
  options: ChatGPTResponsesOptions
): AsyncGenerator<LlmToolLoopStreamEvent> {
  return runResponses(request, options, true);
}

export async function generateChatGPTStructured(
  request: LlmStructuredRequest,
  options: ChatGPTResponsesOptions
): Promise<LlmStructuredResponse> {
  const response: LlmStructuredResponse = {
    id: '',
    model: request.model,
    output_text: '',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    finish_reason: 'stop',
  };
  for await (const event of runResponses(
    {
      model: request.model,
      messages: request.messages,
      reasoning: request.reasoning,
      responseSchema: request.schema,
    },
    options,
    request.strict ?? true
  )) {
    if (event.type === 'message_start') {
      response.id = event.id ?? response.id;
      response.model = event.model ?? response.model;
    } else if (event.type === 'text_delta') {
      response.output_text += event.text;
    } else if (event.type === 'usage') {
      response.usage = event.usage;
    }
  }
  try {
    response.output_json = JSON.parse(response.output_text);
  } catch {
    throw new ChatGPTResponsesError(
      'ChatGPT returned invalid structured output',
      'invalid_structured_output'
    );
  }
  return response;
}
