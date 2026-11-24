import ava from 'ava';

import {
  generateChatGPTStructured,
  streamChatGPTResponses,
} from '../../plugins/copilot/chatgpt/responses';

async function collect<T>(stream: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function eventStream(...events: object[]) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(
    events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5) {
          controller.enqueue(bytes.subarray(i, i + 5));
        }
        controller.close();
      },
    })
  );
}

const model = 'account-model';
const userMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
const getAccessToken = async () => 'example-token';

ava(
  'uses the subscription transport and preserves tools, history and stream events',
  async t => {
    const requests: Record<string, unknown>[] = [];
    const reasoning = {
      type: 'reasoning',
      id: 'rs_123',
      encrypted_content: 'opaque',
    };
    const call = {
      type: 'function_call',
      call_id: 'call_123',
      name: 'readDoc',
      namespace: 'affine',
      arguments: '{"id":"123"}',
    };
    const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
    const events = await collect(
      streamChatGPTResponses(
        {
          model,
          messages: [
            {
              role: 'system',
              content: [{ type: 'text', text: 'Instructions' }],
            },
            userMessage,
          ],
          maxTokens: 100,
          temperature: 0.8,
          reasoning: { effort: 'xhigh' },
          tools: [{ name: 'readDoc', parameters: { type: 'object' } }],
        },
        {
          getAccessToken,
          fetch: async (url, init) => {
            t.is(url, 'https://api.openai.com/v1/responses');
            t.is(
              new Headers(init?.headers).get('Authorization'),
              'Bearer example-token'
            );
            t.is(init?.redirect, 'error');
            requests.push(JSON.parse(String(init?.body)));
            const id = `resp_${requests.length}`;
            if (requests.length === 1) {
              return eventStream(
                { type: 'response.created', response: { id, model } },
                {
                  type: 'response.reasoning_summary_text.delta',
                  delta: 'Thinking',
                },
                {
                  type: 'response.completed',
                  response: { id, model, output: [reasoning, call], usage },
                }
              );
            }
            return eventStream(
              { type: 'response.created', response: { id, model } },
              { type: 'response.output_text.delta', delta: '你好' },
              {
                type: 'response.completed',
                response: {
                  id,
                  model,
                  usage,
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: '你好' }],
                    },
                  ],
                },
              }
            );
          },
          executeTool: async request => {
            t.is(request.name, 'readDoc');
            t.deepEqual(request.args, { id: '123' });
            return { ...request, output: { title: 'Doc 123' } };
          },
        }
      )
    );

    const initialInput = [
      { role: 'developer', content: 'Instructions' },
      { role: 'user', content: 'hi' },
    ];
    t.deepEqual(requests[0], {
      model,
      input: initialInput,
      store: false,
      stream: true,
      reasoning: { effort: 'xhigh' },
      tools: [
        {
          type: 'namespace',
          name: 'affine',
          description: 'Tools provided by AFFiNE',
          tools: [
            {
              type: 'function',
              name: 'readDoc',
              parameters: { type: 'object' },
              strict: false,
            },
          ],
        },
      ],
    });
    t.deepEqual(requests[1].input, [
      ...initialInput,
      reasoning,
      call,
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: '{"title":"Doc 123"}',
      },
    ]);
    t.deepEqual(
      events.map(event => event.type),
      [
        'message_start',
        'reasoning_delta',
        'tool_call',
        'tool_result',
        'message_start',
        'text_delta',
        'usage',
        'done',
      ]
    );
    t.deepEqual(events[5], { type: 'text_delta', text: '你好' });
    t.deepEqual(events[7], {
      type: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    });
  }
);

ava(
  'streams structured output and sends multimodal parts as Responses inputs',
  async t => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    const result = await generateChatGPTStructured(
      {
        model,
        schema,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Name this' },
              {
                type: 'image',
                source: { media_type: 'image/png', data: 'aGk=' },
              },
            ],
          },
        ],
      },
      {
        getAccessToken,
        fetch: async (_url, init) => {
          t.deepEqual(JSON.parse(String(init?.body)), {
            model,
            stream: true,
            store: false,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: 'Name this' },
                  {
                    type: 'input_image',
                    detail: 'auto',
                    image_url: 'data:image/png;base64,aGk=',
                  },
                ],
              },
            ],
            text: {
              format: {
                type: 'json_schema',
                name: 'affine_response',
                schema,
                strict: true,
              },
            },
          });
          return eventStream({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              model,
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: '{"title":"Doc"}' }],
                },
              ],
            },
          });
        },
      }
    );
    t.is(result.model, model);
    t.deepEqual(result.output_json, { title: 'Doc' });
  }
);

ava(
  'rejects interrupted streams and exposes sanitized subscription errors',
  async t => {
    const request = { model, messages: [userMessage] };
    await t.throwsAsync(
      collect(
        streamChatGPTResponses(request, {
          getAccessToken,
          fetch: async () =>
            eventStream({
              type: 'response.output_text.delta',
              delta: 'Partial',
            }),
        })
      ),
      { message: 'ChatGPT stream ended before completion' }
    );
    const error = await t.throwsAsync(
      collect(
        streamChatGPTResponses(request, {
          getAccessToken,
          fetch: async () =>
            eventStream({
              type: 'response.failed',
              response: {
                error: {
                  code: 'subscription_sharing_usage_limit_exceeded',
                  message: 'Private user content',
                },
              },
            }),
        })
      ),
      {
        message:
          'ChatGPT stream failed (subscription_sharing_usage_limit_exceeded)',
      }
    );
    t.like(error, { code: 'subscription_sharing_usage_limit_exceeded' });
  }
);
