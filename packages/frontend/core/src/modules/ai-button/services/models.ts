import { apis } from '@affine/electron-api';
import { getCopilotRouteOptionsQuery } from '@affine/graphql';
import { signal } from '@preact/signals-core';
import { Service } from '@toeverything/infra';

import type {
  FetchService,
  GraphQLService,
  ServerService,
  SubscriptionService,
} from '../../cloud';
import type { GlobalStateService } from '../../storage';
import type { UrlService } from '../../url';
import {
  ChatGPTSubscriptionClient,
  isLocalSubscriptionServer,
} from './chatgpt-subscription';

const ROUTE_TARGET_KEY = 'AIManagedRouteTarget';

export interface AIModel {
  id: string;
  name: string;
  category: string;
  version: string;
  available: boolean;
}

export class AIModelService extends Service {
  readonly modelId = signal<string | undefined>(undefined);
  readonly models = signal<AIModel[]>([]);
  readonly chatGPT?: ChatGPTSubscriptionClient;
  readonly desktopGateway = signal<{ model: string; effort?: string }>();

  private workspaceId: string | undefined;
  private routeId: string | undefined;
  private requestId = 0;

  constructor(
    private readonly globalStateService: GlobalStateService,
    private readonly gqlService: GraphQLService,
    subscriptionService: SubscriptionService,
    fetchService?: FetchService,
    serverService?: ServerService,
    urlService?: UrlService
  ) {
    super();
    const desktop = BUILD_CONFIG.isElectron ? apis?.desktopAI : undefined;
    if (
      fetchService &&
      serverService &&
      urlService &&
      (desktop || isLocalSubscriptionServer(serverService.server.baseUrl))
    ) {
      const chatGPT = new ChatGPTSubscriptionClient(
        fetchService,
        urlService,
        desktop
      );
      this.chatGPT = chatGPT;
      this.disposables.push(() => chatGPT.dispose());
    }
    const subscription = subscriptionService.subscription.ai$.subscribe(() => {
      if (this.workspaceId && this.routeId) {
        this.load(this.workspaceId, this.routeId).catch(console.error);
      }
    });
    this.disposables.push(() => subscription.unsubscribe());
  }

  setScope(workspaceId: string, routeId: string) {
    if (workspaceId === this.workspaceId && routeId === this.routeId) return;
    this.workspaceId = workspaceId;
    this.routeId = routeId;
    this.models.value = [];
    this.modelId.value = undefined;
    this.load(workspaceId, routeId).catch(console.error);
    this.chatGPT?.refresh().catch(console.error);
    this.refreshDesktopRoute().catch(console.error);
  }

  async refreshDesktopRoute() {
    const desktop = BUILD_CONFIG.isElectron ? apis?.desktopAI : undefined;
    if (desktop) {
      const status = await desktop.status();
      this.desktopGateway.value =
        status.mode === 'gateway' ? status.gateway : undefined;
    }
  }

  resetModel() {
    this.setModel(undefined);
  }

  setModel(modelId: string | undefined) {
    if (!this.workspaceId || !this.routeId) return;
    if (
      modelId &&
      !this.models.value.find(model => model.id === modelId)?.available
    ) {
      return;
    }
    this.modelId.value = modelId;
    this.globalStateService.globalState.set(
      this.storageKey(this.workspaceId, this.routeId),
      modelId
    );
  }

  private async load(workspaceId: string, routeId: string) {
    const requestId = ++this.requestId;
    const result = await this.gqlService.gql({
      query: getCopilotRouteOptionsQuery,
      variables: { promptName: routeId },
    });
    if (requestId !== this.requestId) return;
    const options = result.currentUser?.copilot?.routeOptions;
    if (!options) {
      this.models.value = [];
      this.modelId.value = undefined;
      return;
    }
    this.models.value = options.choices.map(choice => {
      const [category] = choice.displayName.split(' ');
      return {
        id: choice.id,
        name: choice.displayName,
        category,
        version: choice.displayName.slice(category.length + 1),
        available: choice.available,
      };
    });
    const selected = this.globalStateService.globalState.get<string>(
      this.storageKey(workspaceId, routeId)
    );
    const selectedAvailable = this.models.value.some(
      model => model.id === selected && model.available
    );
    this.modelId.value = selectedAvailable ? selected : undefined;
    if (selected && !selectedAvailable) {
      this.globalStateService.globalState.set(
        this.storageKey(workspaceId, routeId),
        undefined
      );
    }
  }

  private storageKey(workspaceId: string, routeId: string) {
    return `${ROUTE_TARGET_KEY}:${workspaceId}:${routeId}`;
  }
}
