import { afterEach, expect, test, vi } from 'vitest';

import type { FetchService } from '../../cloud';
import { ChatGPTSubscriptionClient } from './chatgpt-subscription';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('polls for authorization and commits the chosen model and effort', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('BUILD_CONFIG', { isNative: true });
  const result = (value: unknown) => Response.json(value);
  const model = {
    id: 'visible-model',
    displayName: 'Visible Model',
    supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'low',
  };
  const preference = { modelId: model.id, effort: 'high' };
  const authorizationUrl = 'https://auth.openai.com/authorize';
  const fetch = vi
    .fn<FetchService['fetch']>()
    .mockResolvedValueOnce(result({ status: 'disconnected' }))
    .mockResolvedValueOnce(result({ authorizationUrl }))
    .mockResolvedValueOnce(result({ status: 'authorizing' }))
    .mockResolvedValueOnce(result({ status: 'connected' }))
    .mockResolvedValueOnce(result([model]))
    .mockResolvedValueOnce(result({ status: 'connected', preference }))
    .mockResolvedValueOnce(result({ status: 'disconnected' }));
  const openExternal = vi.fn();
  const client = new ChatGPTSubscriptionClient({ fetch }, { openExternal });

  try {
    await client.refresh();
    await client.connect();
    expect(openExternal).toHaveBeenCalledWith(authorizationUrl);
    expect(client.connection.value.status).toBe('authorizing');
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.connection.value.status).toBe('connected');
    expect(client.models.value).toEqual([model]);

    const saving = client.setPreference(model.id, 'high');
    expect(client.changingPreference.value).toBe(true);
    expect(client.connection.value.preference).toBeUndefined();
    await saving;
    expect(client.changingPreference.value).toBe(false);
    expect(client.connection.value.preference).toEqual(preference);
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/copilot/chatgpt/preference',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(preference),
      })
    );

    await client.disconnect();
    expect(client.connection.value.status).toBe('disconnected');
    expect(client.models.value).toEqual([]);
  } finally {
    client.dispose();
  }
});
