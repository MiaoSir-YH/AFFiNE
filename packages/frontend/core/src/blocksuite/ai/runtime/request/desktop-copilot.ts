import { apis } from '@affine/electron-api';
import {
  cleanupCopilotSessionMutation,
  createCopilotMessageMutation,
  createCopilotSessionMutation,
  createCopilotSessionWithHistoryMutation,
  forkCopilotSessionMutation,
  getCopilotHistoriesQuery,
  getCopilotHistoryIdsQuery,
  getCopilotRecentSessionsQuery,
  getCopilotSessionQuery,
  getCopilotSessionsQuery,
  type GraphQLQuery,
  type QueryOptions,
  type QueryResponse,
  updateCopilotSessionMutation,
} from '@affine/graphql';
import { getOrCreateI18n } from '@affine/i18n';

type Gql = <Query extends GraphQLQuery>(
  options: QueryOptions<Query>
) => Promise<QueryResponse<Query>>;
type EventSourceFactory = (
  url: string,
  options?: EventSourceInit
) => EventSource;

export function desktopAI(): NonNullable<typeof apis>['desktopAI'] | undefined {
  return BUILD_CONFIG.isElectron ? apis?.desktopAI : undefined;
}

export function isDesktopSession(id: unknown): id is `desktop-ai-${string}` {
  return typeof id === 'string' && /^desktop-ai-[0-9a-f-]{36}$/.test(id);
}

async function encodeFile(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const listQueries = new Set<GraphQLQuery>([
  getCopilotHistoriesQuery,
  getCopilotHistoryIdsQuery,
  getCopilotRecentSessionsQuery,
  getCopilotSessionQuery,
  getCopilotSessionsQuery,
]);

export function routeDesktopQueries(gql: Gql): Gql {
  const desktop = desktopAI();
  if (!desktop) return gql;
  return async <Query extends GraphQLQuery>(request: QueryOptions<Query>) => {
    const query: GraphQLQuery = request.query;
    const variables =
      (request as { variables?: Record<string, any> }).variables ?? {};
    const input = variables.options ?? {};
    const sessionId = input.sessionId ?? variables.sessionId;
    const creating =
      query === createCopilotSessionMutation ||
      query === createCopilotSessionWithHistoryMutation;
    const selecting = listQueries.has(query);
    const deleting = query === cleanupCopilotSessionMutation;
    const explicit =
      isDesktopSession(sessionId) ||
      (deleting && variables.input?.sessionIds?.some(isDesktopSession));
    const sending =
      query === createCopilotMessageMutation ||
      query === forkCopilotSessionMutation;
    const active =
      explicit ||
      ((creating || selecting || deleting || sending) &&
        (await desktop.status()).mode !== 'affine');
    if (!active) return gql(request);
    if (sending && !isDesktopSession(sessionId)) {
      throw new Error('Start a new AI chat with your desktop provider.');
    }
    if (request.signal?.aborted)
      throw new DOMException('Request aborted', 'AbortError');
    let result: unknown;
    if (creating) {
      const session = await desktop.createSession(input);
      result =
        query === createCopilotSessionMutation
          ? { createCopilotSession: session.sessionId }
          : { createCopilotSessionWithHistory: session };
    } else if (query === createCopilotMessageMutation) {
      const blobs = (input.blobs ?? []) as Blob[];
      const attachments: string[] = [
        ...(input.attachments ?? []),
        ...(await Promise.all(blobs.map(encodeFile))),
      ];
      if (attachments.some(attachment => !attachment.startsWith('data:'))) {
        throw new Error(
          'Open this attachment locally before sending it to your AI provider.'
        );
      }
      result = {
        createCopilotMessage: await desktop.createMessage({
          sessionId,
          content: input.content,
          params: input.params,
          attachments,
        }),
      };
    } else if (query === updateCopilotSessionMutation) {
      result = { updateCopilotSession: await desktop.updateSession(input) };
    } else if (query === forkCopilotSessionMutation) {
      const session = await desktop.forkSession(
        sessionId,
        input.docId,
        input.latestMessageId
      );
      result = { forkCopilotSession: session.sessionId };
    } else if (deleting) {
      const { workspaceId, sessionIds } = variables.input;
      result = {
        cleanupCopilotSession: await desktop.deleteSessions(
          workspaceId,
          sessionIds.filter(isDesktopSession)
        ),
      };
    } else if (selecting) {
      const pagination = variables.pagination ?? {};
      const sessions = await desktop.listSessions(
        variables.workspaceId,
        variables.docId,
        { ...input, ...(sessionId ? { sessionId } : {}) },
        pagination.offset ?? variables.offset ?? input.skip,
        pagination.first ?? variables.limit ?? input.limit
      );
      result = {
        currentUser: {
          copilot: {
            chats: {
              edges: sessions.map(node => ({ cursor: node.sessionId, node })),
              pageInfo: {
                hasNextPage: false,
                hasPreviousPage: false,
                startCursor: null,
                endCursor: null,
              },
            },
          },
        },
      };
    } else {
      throw new Error('This operation is unavailable for desktop AI.');
    }
    if (request.signal?.aborted)
      throw new DOMException('Request aborted', 'AbortError');
    return result as QueryResponse<Query>;
  };
}

export function routeDesktopEvents(
  eventSource: EventSourceFactory
): EventSourceFactory {
  const desktop = desktopAI();
  if (!desktop) return eventSource;
  return (path, options) => {
    const url = new URL(path, 'https://local.invalid');
    const sessionId = url.pathname.split('/')[4];
    if (!isDesktopSession(sessionId)) return eventSource(path, options);
    const source = new EventTarget();
    const state = {
      get readyState() {
        return readyState;
      },
      close() {
        readyState = EventSource.CLOSED;
        if (id) desktop.closeStream(id).catch(() => undefined);
      },
    };
    let id: string | undefined;
    let readyState: number = EventSource.CONNECTING;
    function finish(error?: unknown) {
      if (readyState === EventSource.CLOSED) return;
      state.close();
      source.dispatchEvent(
        new MessageEvent('error', {
          data: error
            ? JSON.stringify({
                status: 500,
                name: 'DESKTOP_AI_ERROR',
                message: error instanceof Error ? error.message : String(error),
              })
            : undefined,
        })
      );
    }
    const plain = url.pathname.endsWith('/stream');
    const image =
      url.pathname.endsWith('/images') ||
      url.searchParams.get('actionId')?.startsWith('image.');
    const lang = getOrCreateI18n().language;
    const language = new Intl.DisplayNames(['en'], {
      type: 'language',
      fallback: 'code',
    });
    const start = async () => {
      id = await desktop.openStream({
        sessionId,
        messageId: url.searchParams.get('messageId'),
        kind: image ? 'image' : plain ? 'text' : 'object',
        language: language.of(lang) ?? 'English',
      });
      if (readyState === EventSource.CLOSED) {
        state.close();
        return;
      }
      readyState = EventSource.OPEN;
      while (state.readyState !== EventSource.CLOSED) {
        const part = await desktop.readStream(id);
        if (!part) break;
        if (state.readyState === EventSource.CLOSED) return;
        source.dispatchEvent(
          new MessageEvent(
            part.type === 'attachment' ? 'attachment' : 'message',
            {
              data:
                part.type === 'attachment' || plain
                  ? part.data
                  : JSON.stringify({
                      type: 'text-delta',
                      textDelta: part.data,
                    }),
            }
          )
        );
      }
      finish();
    };
    queueMicrotask(() => {
      start().catch(finish);
    });
    return Object.defineProperties(source, {
      readyState: { get: () => state.readyState },
      close: { value: state.close },
    }) as unknown as EventSource;
  };
}
