import {
  Injectable,
  NotFoundException,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Request } from 'express';

import { BadRequest } from '../../../base/error/errors.gen';
import { ChatGPTAuth, type ChatGPTModel } from './auth';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const localAddresses = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

function isLocalWebOrigin(origin: string) {
  const url = URL.parse(origin);
  return (
    !!url &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    localHosts.has(url.hostname)
  );
}

export function allowsChatGPTSubscription(request: Request) {
  if (
    env.DEPLOYMENT_TYPE !== 'selfhosted' ||
    process.env.AFFINE_CHATGPT_SUBSCRIPTION !== 'true' ||
    !localAddresses.has(request.socket?.remoteAddress ?? '') ||
    request.headers.forwarded ||
    request.headers['x-forwarded-for']
  ) {
    return false;
  }
  if (!isLocalWebOrigin(`http://${request.headers.host ?? ''}`)) {
    return false;
  }
  const origin = request.headers.origin;
  return !origin || origin === 'assets://.' || isLocalWebOrigin(origin);
}

@Injectable()
export class ChatGPTSubscription implements OnApplicationShutdown {
  private readonly auth = new ChatGPTAuth({
    codexExecutable: process.env.AFFINE_CHATGPT_CODEX_EXECUTABLE,
    dataDirectory: process.env.AFFINE_CHATGPT_DATA_DIR,
  });
  private ownerId?: string;
  private accountGeneration = 0;
  private models?: Promise<readonly ChatGPTModel[]>;
  private preference?: { modelId: string; effort?: string };

  isAvailable(userId: string, request: Request) {
    return (
      allowsChatGPTSubscription(request) &&
      (!this.ownerId || this.ownerId === userId)
    );
  }

  status(userId: string, request: Request) {
    if (!this.isAvailable(userId, request)) return { status: 'unavailable' };
    return { ...this.auth.state(), preference: this.preference };
  }

  start(userId: string, request: Request, simplifiedChinese = false) {
    if (!this.isAvailable(userId, request)) throw new NotFoundException();
    this.ownerId = userId;
    return this.auth.start({ simplifiedChinese });
  }

  async listModels(userId: string, request: Request) {
    if (!this.isAvailable(userId, request)) throw new NotFoundException();
    if (this.ownerId !== userId || this.auth.state().status !== 'connected') {
      return [];
    }
    this.models ??= this.auth.models().catch(error => {
      this.models = undefined;
      throw error;
    });
    return this.models;
  }

  async setPreference(
    userId: string,
    request: Request,
    preference: { modelId: string | null; effort?: string }
  ) {
    if (!this.isAvailable(userId, request)) throw new NotFoundException();
    if (preference.modelId === null) {
      this.preference = undefined;
      return this.status(userId, request);
    }

    const generation = this.accountGeneration;
    const model = (await this.listModels(userId, request)).find(
      item => item.id === preference.modelId
    );
    if (
      !model ||
      (preference.effort &&
        !model.supportedReasoningEfforts?.includes(preference.effort)) ||
      generation !== this.accountGeneration ||
      this.ownerId !== userId ||
      this.auth.state().status !== 'connected'
    ) {
      throw new BadRequest('Unavailable ChatGPT model or effort');
    }
    this.preference = { modelId: model.id, effort: preference.effort };
    return this.status(userId, request);
  }

  select(userId: string | undefined) {
    const preference = this.preference;
    if (!userId || this.ownerId !== userId || !preference) return undefined;
    const generation = this.accountGeneration;
    return {
      ...preference,
      getAccessToken: () => {
        if (this.ownerId !== userId || generation !== this.accountGeneration) {
          throw new BadRequest('ChatGPT subscription is disconnected');
        }
        return this.auth.accessToken();
      },
    };
  }

  async disconnect(userId: string, request: Request) {
    if (!this.isAvailable(userId, request)) throw new NotFoundException();
    await this.onApplicationShutdown();
    return this.status(userId, request);
  }

  async onApplicationShutdown() {
    this.accountGeneration++;
    this.preference = undefined;
    this.models = undefined;
    try {
      await this.auth.disconnect();
    } finally {
      this.ownerId = undefined;
    }
  }
}
