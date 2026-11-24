import type { IncomingMessage } from 'node:http';

export const chatGPTCallbackHost = '127.0.0.1';
export const chatGPTCallbackPath = '/affine/chatgpt/callback';

export function isChatGPTCallbackRequest(request: IncomingMessage): boolean {
  return (
    request.socket.localAddress === chatGPTCallbackHost &&
    request.url?.split('?', 1)[0] === chatGPTCallbackPath
  );
}
