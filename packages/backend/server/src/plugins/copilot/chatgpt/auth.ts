import { ChatGPTAuth as SharedChatGPTAuth } from '@affine/auth/chatgpt';

import { chatGPTApplicationName, readCodexCatalog } from './codex-catalog';

export type { ChatGPTAuthState, ChatGPTModel } from '@affine/auth/chatgpt';

export class ChatGPTAuth extends SharedChatGPTAuth {
  constructor(
    options: NonNullable<ConstructorParameters<typeof SharedChatGPTAuth>[0]> & {
      codexExecutable?: string;
    } = {}
  ) {
    const { codexExecutable, ...sharedOptions } = options;
    super({
      ...sharedOptions,
      applicationName: chatGPTApplicationName,
      loadModelMetadata: codexExecutable
        ? token => readCodexCatalog(codexExecutable, token)
        : undefined,
    });
  }
}
