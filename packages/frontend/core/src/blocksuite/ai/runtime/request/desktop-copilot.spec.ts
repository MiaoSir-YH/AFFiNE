/**
 * @vitest-environment happy-dom
 */
import {
  createCopilotMessageMutation,
  createCopilotSessionMutation,
} from '@affine/graphql';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { routeDesktopEvents, routeDesktopQueries } from './desktop-copilot';

const desktop = vi.hoisted(() => ({
  status: vi.fn(),
  createSession: vi.fn(),
  createMessage: vi.fn(),
  openStream: vi.fn(),
  readStream: vi.fn(),
  closeStream: vi.fn(),
}));

vi.mock('@affine/electron-api', () => ({ apis: { desktopAI: desktop } }));
vi.mock('@affine/i18n', () => ({
  getOrCreateI18n: () => ({ language: 'zh-Hans' }),
}));

const sessionId = 'desktop-ai-00000000-0000-4000-8000-000000000001';
const create = {
  query: createCopilotSessionMutation,
  variables: { options: { workspaceId: 'workspace', promptName: 'Summary' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('BUILD_CONFIG', { isElectron: true });
  vi.stubGlobal('EventSource', { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  desktop.status.mockResolvedValue({ mode: 'gateway' });
});

afterEach(() => vi.unstubAllGlobals());

describe('desktop AI provider privacy', () => {
  test('keeps a new session and its message off the AFFiNE service', async () => {
    const cloud = vi.fn();
    const gql = routeDesktopQueries(cloud);
    desktop.createSession.mockResolvedValue({ sessionId });
    desktop.createMessage.mockResolvedValue('message');

    await expect(gql(create)).resolves.toEqual({
      createCopilotSession: sessionId,
    });
    await expect(
      gql({
        query: createCopilotMessageMutation,
        variables: { options: { sessionId, content: 'private selection' } },
      })
    ).resolves.toEqual({ createCopilotMessage: 'message' });

    expect(cloud).not.toHaveBeenCalled();
    expect(desktop.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, content: 'private selection' })
    );
  });

  test('rejects a stale cloud session when the desktop route is active', async () => {
    const cloud = vi.fn();
    await expect(
      routeDesktopQueries(cloud)({
        query: createCopilotMessageMutation,
        variables: {
          options: { sessionId: 'cloud-session', content: 'private content' },
        },
      })
    ).rejects.toThrow('Start a new AI chat');
    expect(cloud).not.toHaveBeenCalled();
  });

  test('keeps the original request path when the desktop provider is disabled', async () => {
    desktop.status.mockResolvedValue({ mode: 'affine' });
    const cloud = vi
      .fn()
      .mockResolvedValue({ createCopilotSession: 'cloud-session' });
    await expect(routeDesktopQueries(cloud)(create)).resolves.toEqual({
      createCopilotSession: 'cloud-session',
    });
    expect(cloud).toHaveBeenCalledWith(create);
  });

  test('projects structured action results as plain text and never opens cloud SSE', async () => {
    const cloud = vi.fn();
    desktop.openStream.mockResolvedValue('stream');
    desktop.readStream
      .mockResolvedValueOnce({ type: 'text', data: '- Root\n  - Child' })
      .mockResolvedValueOnce(null);
    desktop.closeStream.mockResolvedValue(undefined);
    const stream = routeDesktopEvents(cloud)(
      '/api/copilot/actions/' + sessionId + '/stream?actionId=mindmap.generate'
    );
    const data: string[] = [];
    stream.addEventListener('message', event =>
      data.push(event.data as string)
    );
    await new Promise<void>(resolve => {
      stream.addEventListener('error', () => resolve(), { once: true });
    });
    expect(data).toEqual(['- Root\n  - Child']);
    expect(stream.readyState).toBe(EventSource.CLOSED);
    expect(cloud).not.toHaveBeenCalled();
  });
});
