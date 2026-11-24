import type { apis } from '@affine/electron-api';
import { getOrCreateI18n } from '@affine/i18n';
import { signal } from '@preact/signals-core';

import type { FetchService } from '../../cloud';
import type { UrlService } from '../../url';

const endpoint = '/api/copilot/chatgpt';

interface ChatGPTModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

type SubscriptionStatus = {
  status:
    | 'unavailable'
    | 'disconnected'
    | 'authorizing'
    | 'connected'
    | 'error';
  preference?: { modelId: string; effort?: string };
};

export function isLocalSubscriptionServer(baseUrl: string) {
  try {
    const { hostname, protocol } = new URL(baseUrl);
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
    );
  } catch {
    return false;
  }
}

export class ChatGPTSubscriptionClient {
  readonly connection = signal<SubscriptionStatus>({ status: 'unavailable' });
  readonly models = signal<ChatGPTModel[]>([]);
  readonly busy = signal(false);
  readonly changingPreference = signal(false);
  readonly modelLoadFailed = signal(false);

  private refreshed = false;
  private authorizationTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly fetcher: Pick<FetchService, 'fetch'>,
    private readonly urlService: Pick<UrlService, 'openExternal'>,
    private readonly desktop?: NonNullable<typeof apis>['desktopAI']
  ) {}

  dispose() {
    this.disposed = true;
    clearTimeout(this.authorizationTimer);
  }

  async refresh() {
    if (this.busy.value || this.disposed) return;
    this.busy.value = true;
    try {
      const previous = this.connection.value.status;
      const status = await this.request<SubscriptionStatus>();
      if (this.disposed) return;
      this.refreshed = true;
      this.connection.value = status;
      if (status.status === 'connected') {
        if (previous !== 'connected' || !this.models.value.length) {
          this.modelLoadFailed.value = false;
          try {
            this.models.value = await this.request<ChatGPTModel[]>('/models');
          } catch {
            this.modelLoadFailed.value = true;
          }
        }
      } else {
        this.models.value = [];
        this.modelLoadFailed.value = false;
      }
      if (status.status === 'authorizing') this.scheduleRefresh();
    } catch (error) {
      if (this.refreshed) throw error;
    } finally {
      this.busy.value = false;
    }
  }

  async connect() {
    if (this.busy.value || this.disposed) return;
    if (this.desktop) {
      this.busy.value = true;
      try {
        this.connection.value = (
          await this.desktop.connectChatGPT(getOrCreateI18n().language)
        ).chatgpt;
        this.scheduleRefresh();
      } finally {
        this.busy.value = false;
      }
      return;
    }
    const popup = BUILD_CONFIG.isNative
      ? null
      : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    this.busy.value = true;
    try {
      const { authorizationUrl } = await this.request<{
        authorizationUrl: string;
      }>('/connect', {
        method: 'POST',
        body: JSON.stringify({ language: getOrCreateI18n().language }),
      });
      const url = new URL(authorizationUrl);
      if (url.origin !== 'https://auth.openai.com') {
        throw new Error('Unexpected ChatGPT authorization URL');
      }
      this.connection.value = { status: 'authorizing' };
      this.scheduleRefresh();
      if (popup) {
        popup.location.replace(url.href);
      } else {
        this.urlService.openExternal(url.href);
      }
    } catch (error) {
      popup?.close();
      throw error;
    } finally {
      this.busy.value = false;
    }
  }

  async setPreference(modelId: string | null, effort?: string) {
    if (this.busy.value || this.disposed) return;
    this.changingPreference.value = true;
    this.busy.value = true;
    try {
      this.connection.value = await this.request<SubscriptionStatus>(
        '/preference',
        { method: 'PUT', body: JSON.stringify({ modelId, effort }) }
      );
    } finally {
      this.changingPreference.value = false;
      this.busy.value = false;
    }
  }

  async disconnect() {
    if (this.busy.value || this.disposed) return;
    this.changingPreference.value = true;
    this.busy.value = true;
    try {
      this.connection.value = await this.request<SubscriptionStatus>('', {
        method: 'DELETE',
      });
      this.models.value = [];
      this.modelLoadFailed.value = false;
      clearTimeout(this.authorizationTimer);
    } finally {
      this.changingPreference.value = false;
      this.busy.value = false;
    }
  }

  private scheduleRefresh() {
    clearTimeout(this.authorizationTimer);
    if (this.disposed) return;
    this.authorizationTimer = setTimeout(() => {
      this.refresh().catch(() => {
        if (this.connection.value.status === 'authorizing') {
          this.scheduleRefresh();
        }
      });
    }, 1500);
  }

  private async request<T>(path = '', init?: RequestInit): Promise<T> {
    if (this.desktop) {
      let result: unknown;
      if (path === '/models') {
        result = await this.desktop.models();
      } else if (path === '/preference') {
        const { modelId, effort } = JSON.parse(String(init?.body));
        result = modelId
          ? (await this.desktop.chooseChatGPT(modelId, effort)).chatgpt
          : {
              ...(await this.desktop.useAffine()).chatgpt,
              preference: undefined,
            };
      } else if (init?.method === 'DELETE') {
        result = (await this.desktop.disconnectChatGPT()).chatgpt;
      } else {
        const status = await this.desktop.status();
        result = {
          ...status.chatgpt,
          preference:
            status.mode === 'chatgpt' ? status.chatgpt.preference : undefined,
        };
      }
      return result as T;
    }
    const response = await this.fetcher.fetch(endpoint + path, {
      ...init,
      cache: 'no-store',
      credentials: 'include',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
    return response.json();
  }
}
