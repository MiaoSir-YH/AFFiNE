import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ChatGPTAuth } from '@affine/auth/chatgpt';
import { app, safeStorage, shell } from 'electron';
import { z } from 'zod';

import { PersistentJSONFileStorage } from '../shared-storage/json-file';
import type { NamespaceHandlers } from '../type';
import {
  buildDesktopMessages,
  type ChatMessage,
  type DesktopGateway,
  type DesktopProvider,
  gatewaySchema,
  providerImage,
  providerText,
  transcribeFiles,
} from './provider';

const directory = app.getPath('userData');
const storage = new PersistentJSONFileStorage(
  join(directory, 'desktop-ai.json')
);
const auth = new ChatGPTAuth({
  applicationName: 'AFFiNE Desktop',
  dataDirectory: join(directory, 'chatgpt'),
});
const nullableId = z.string().max(256).nullish();
const sessionOptions = z.object({
  workspaceId: z.string().min(1).max(256),
  docId: nullableId,
  promptName: z.string().min(1).max(110),
  pinned: z.boolean().optional(),
  reuseLatestChat: z.boolean().optional(),
});
const identifier = z.string().regex(/^desktop-ai-[0-9a-f-]{36}$/);
const content = z.string().max(1_000_000).nullish();
const storedMessage = z.object({
  sessionId: identifier,
  content,
  attachments: z.array(z.string().max(15_000_000)).max(10).optional(),
  params: z.record(z.unknown()).optional(),
});

type Mode = 'affine' | 'gateway' | 'chatgpt';
type Preference = { modelId: string; effort?: string };
type Message = ChatMessage & {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string;
  params?: Record<string, unknown>;
};
type Session = {
  sessionId: string;
  workspaceId: string;
  docId?: string | null;
  parentSessionId?: string;
  promptName: string;
  action: string | null;
  pinned: boolean;
  title?: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};
type Part = { type: 'text' | 'attachment'; data: string };

const sessions = new Map(
  (storage.get<Session[]>('sessions') ?? []).map(session => [
    session.sessionId,
    session,
  ])
);
const activeRuns = new Map<
  string,
  {
    owner: number;
    controller: AbortController;
    iterator: AsyncGenerator<Part>;
    release: () => void;
  }
>();
let catalog: ReturnType<ChatGPTAuth['models']> | undefined;
const preference = () => storage.get<Preference>('chatgpt-preference');
const mode = () => storage.get<Mode>('mode') ?? 'affine';

function getGateway() {
  const encrypted = storage.get<string>('gateway');
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return gatewaySchema.parse(
      JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
    );
  } catch {
    return undefined;
  }
}

function status() {
  const gateway = getGateway();
  return {
    mode: mode(),
    chatgpt: { ...auth.state(), preference: preference() },
    gateway: gateway
      ? {
          baseUrl: gateway.baseUrl,
          model: gateway.model,
          dialect: gateway.dialect,
          effort: gateway.effort,
          imageModel: gateway.imageModel,
          transcriptionModel: gateway.transcriptionModel,
        }
      : undefined,
  };
}

function getModels() {
  catalog ??= auth.models().catch(error => {
    catalog = undefined;
    throw error;
  });
  return catalog;
}

async function currentProvider(): Promise<DesktopProvider> {
  if (mode() === 'gateway') {
    const gateway = getGateway();
    if (gateway) return gateway;
  }
  if (mode() === 'chatgpt') {
    const selected = preference();
    if (selected)
      return {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: await auth.accessToken(),
        model: selected.modelId,
        effort: selected.effort,
        dialect: 'responses',
        subscription: true,
      };
  }
  throw new Error('Select your desktop AI provider and model in Settings.');
}

function sessionFor(id: string) {
  const result = sessions.get(identifier.parse(id));
  if (!result) throw new Error('This local AI session is unavailable.');
  return result;
}

function changed(session: Session) {
  session.updatedAt = new Date().toISOString();
  storage.set('sessions', [...sessions.values()]);
}

function create(input: z.infer<typeof sessionOptions>, parent?: Session) {
  const existing = input.reuseLatestChat
    ? list(input.workspaceId, input.docId ?? undefined, {
        action: false,
        fork: false,
      })[0]
    : undefined;
  if (existing && existing.promptName === input.promptName) return existing;
  const sessionId = 'desktop-ai-' + randomUUID();
  const now = new Date().toISOString();
  const session: Session = {
    ...input,
    sessionId,
    parentSessionId: parent?.sessionId,
    pinned: input.pinned ?? false,
    action:
      input.promptName !== 'Chat With AFFiNE AI' ? input.promptName : null,
    messages: parent ? parent.messages.slice() : [],
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(sessionId, session);
  changed(session);
  return session;
}

const queryOptions = z.object({
  sessionId: nullableId,
  action: z.boolean().nullish(),
  fork: z.boolean().nullish(),
  withMessages: z.boolean().nullish(),
  pinned: z.boolean().nullish(),
  sessionOrder: z.string().nullish(),
});
type QueryOptions = z.infer<typeof queryOptions>;

function list(workspaceId: string, docId?: string, options?: QueryOptions) {
  return [...sessions.values()]
    .filter(session => session.workspaceId === workspaceId)
    .filter(session => docId === undefined || session.docId === docId)
    .filter(
      session =>
        options?.sessionId == null || session.sessionId === options.sessionId
    )
    .filter(
      session =>
        options?.action == null || Boolean(session.action) === options.action
    )
    .filter(
      session => options?.pinned == null || session.pinned === options.pinned
    )
    .filter(session => options?.fork !== false || !session.parentSessionId)
    .sort((a, b) =>
      options?.sessionOrder === 'asc'
        ? a.updatedAt.localeCompare(b.updatedAt)
        : b.updatedAt.localeCompare(a.updatedAt)
    );
}

const streamOptions = z.object({
  sessionId: identifier,
  messageId: nullableId,
  kind: z.enum(['text', 'object', 'image']),
  language: z.string().max(80).default('English'),
});

async function* streamResult(
  input: z.infer<typeof streamOptions>,
  signal: AbortSignal
): AsyncGenerator<Part> {
  const session = sessionFor(input.sessionId);
  const index = input.messageId
    ? session.messages.findIndex(message => message.id === input.messageId)
    : session.messages.findLastIndex(message => message.role === 'user');
  const message = session.messages[index];
  if (!message || message.role !== 'user')
    throw new Error('This AI message is unavailable.');
  const provider = await currentProvider();
  let result = '';
  let attachments: string[] = [];
  if (input.kind === 'image') {
    const image = await providerImage(
      getGateway() ?? provider,
      message.content ?? '',
      signal,
      message.attachments
    );
    attachments = [image];
    yield { type: 'attachment', data: image };
  } else {
    const messages = buildDesktopMessages(
      session.promptName,
      session.messages.slice(0, index + 1),
      message.params ?? {},
      input.language
    );
    const structured = ['mindmap.generate', 'slides.outline'].includes(
      session.promptName
    );
    for await (const text of providerText(
      provider,
      messages,
      signal,
      structured
    )) {
      result += text;
      if (!structured) yield { type: 'text', data: text };
    }
    if (structured) {
      result = z
        .object({ result: z.string().min(1) })
        .parse(JSON.parse(result)).result;
      yield { type: 'text', data: result };
    }
  }
  if (signal.aborted || !sessions.has(session.sessionId)) return;
  const assistant: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: result,
    attachments,
    createdAt: new Date().toISOString(),
  };
  if (session.messages[index + 1]?.role === 'assistant')
    session.messages.splice(index + 1, 1, assistant);
  else session.messages.splice(index + 1, 0, assistant);
  changed(session);
}

export const desktopAIHandlers = {
  status: async () => status(),
  models: async () => getModels(),
  connectChatGPT: async (_, language: string) => {
    const { authorizationUrl } = await auth.start({
      simplifiedChinese: /^zh-(Hans|CN)/i.test(language),
    });
    await shell.openExternal(authorizationUrl);
    return status();
  },
  disconnectChatGPT: async () => {
    await auth.disconnect();
    catalog = undefined;
    storage.del('chatgpt-preference');
    return status();
  },
  chooseChatGPT: async (_, modelId: string, effort?: string) => {
    const model = (await getModels()).find(item => item.id === modelId);
    if (
      !model ||
      (effort && !model.supportedReasoningEfforts?.includes(effort))
    ) {
      throw new Error('This ChatGPT model or reasoning effort is unavailable.');
    }
    storage.set('chatgpt-preference', { modelId, effort });
    storage.set('mode', 'chatgpt');
    return status();
  },
  saveGateway: async (_, input: unknown) => {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Secure credential storage is unavailable.');
    const existing = getGateway();
    const config = gatewaySchema.parse({
      ...existing,
      ...z.record(z.unknown()).parse(input),
    }) as DesktopGateway;
    storage.set(
      'gateway',
      safeStorage.encryptString(JSON.stringify(config)).toString('base64')
    );
    storage.set('mode', 'gateway');
    return status();
  },
  useAffine: async () => {
    storage.set('mode', 'affine');
    return status();
  },
  createSession: async (_, input: unknown) =>
    create(sessionOptions.parse(input)),
  forkSession: async (
    _,
    sessionId: string,
    docId: string,
    messageId?: string
  ) => {
    const parent = sessionFor(sessionId);
    const fork = create(
      sessionOptions.parse({ ...parent, docId, reuseLatestChat: false }),
      parent
    );
    if (messageId) {
      const index = fork.messages.findIndex(
        message => message.id === messageId
      );
      if (index >= 0) fork.messages = fork.messages.slice(0, index + 1);
      changed(fork);
    }
    return fork;
  },
  updateSession: async (_, input: unknown) => {
    const { sessionId, title, pinned } = z
      .object({
        sessionId: identifier,
        title: z.string().max(500).nullish(),
        pinned: z.boolean().nullish(),
      })
      .parse(input);
    const session = sessionFor(sessionId);
    if (title != null) session.title = title;
    if (pinned != null) session.pinned = pinned;
    changed(session);
    return sessionId;
  },
  createMessage: async (_, input: unknown) => {
    const options = storedMessage.parse(input);
    const session = sessionFor(options.sessionId);
    const id = randomUUID();
    session.messages.push({
      id,
      role: 'user',
      content: options.content,
      attachments: options.attachments,
      params: options.params,
      createdAt: new Date().toISOString(),
    });
    session.title ??= options.content?.trim().slice(0, 80);
    changed(session);
    return id;
  },
  listSessions: async (
    _,
    workspaceId: string,
    docId?: string,
    input?: unknown,
    offset = 0,
    limit = 100
  ) => {
    const options = queryOptions.optional().parse(input);
    return list(workspaceId, docId, options)
      .slice(offset, offset + limit)
      .map(session => ({
        ...session,
        messages: options?.withMessages === false ? [] : session.messages,
      }));
  },
  deleteSessions: async (_, workspaceId: string, ids: string[]) => {
    const selected = z.array(identifier).parse(ids);
    for (const id of selected)
      if (sessions.get(id)?.workspaceId === workspaceId) sessions.delete(id);
    storage.set('sessions', [...sessions.values()]);
    return selected.length;
  },
  openStream: async (event, input: unknown) => {
    const options = streamOptions.parse(input);
    const id = randomUUID();
    const controller = new AbortController();
    const release = () => {
      controller.abort();
      activeRuns.delete(id);
      event.sender.off('destroyed', release);
    };
    event.sender.once('destroyed', release);
    const iterator = streamResult(
      options,
      AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)])
    );
    activeRuns.set(id, {
      owner: event.sender.id,
      controller,
      iterator,
      release,
    });
    return id;
  },
  readStream: async (event, id: string) => {
    const run = activeRuns.get(id);
    if (!run || run.owner !== event.sender.id) return null;
    try {
      const result = await run.iterator.next();
      if (result.done) run.release();
      return result.done ? null : result.value;
    } catch (error) {
      run.release();
      throw error;
    }
  },
  closeStream: async (event, id: string) => {
    const run = activeRuns.get(id);
    if (run?.owner !== event.sender.id) return;
    run.release();
    await run.iterator.return(undefined);
  },
  transcribe: async (_, value: unknown) => {
    const files = z
      .array(
        z.object({
          bytes: z
            .instanceof(Uint8Array)
            .refine(bytes => bytes.length <= 32 * 1024 * 1024),
          name: z.string().max(256),
          type: z.string().max(100),
        })
      )
      .min(1)
      .max(20)
      .parse(value);
    const gateway = getGateway();
    if (mode() === 'affine' || !gateway?.transcriptionModel) {
      throw new Error(
        'Configure a transcription model for your desktop gateway.'
      );
    }
    const limit = AbortSignal.timeout(10 * 60 * 1000);
    const segments = await transcribeFiles(gateway, files, limit);
    const text = segments.map(segment => segment.transcription).join('\n');
    const provider = await currentProvider();
    const summarize = async (promptName: string) => {
      if (!text.trim()) return '';
      let output = '';
      for await (const chunk of providerText(
        provider,
        buildDesktopMessages(
          promptName,
          [{ role: 'user', content: text }],
          {},
          'the language of the transcript'
        ),
        limit
      ))
        output += chunk;
      return output;
    };
    const [title, summary, actions] = await Promise.all([
      summarize('Summary as title'),
      summarize('Summarize the meeting'),
      summarize('Find action items from it'),
    ]);
    return { title, summary, actions, segments };
  },
} satisfies NamespaceHandlers;
