import test from 'ava';
import type { Request } from 'express';
import Sinon from 'sinon';

import { ChatGPTAuth } from '../../plugins/copilot/chatgpt/auth';
import {
  allowsChatGPTSubscription,
  ChatGPTSubscription,
} from '../../plugins/copilot/chatgpt/subscription';

function request(
  headers: Request['headers'] = {},
  remoteAddress = '127.0.0.1'
) {
  return {
    headers: { host: 'localhost:3010', ...headers },
    socket: { remoteAddress },
  } as Request;
}

test.serial(
  'ChatGPT subscription requires a direct local client and is bound to one AFFiNE user',
  async t => {
    const originalEnv = globalThis.env;
    const enabled = process.env.AFFINE_CHATGPT_SUBSCRIPTION;
    globalThis.env = {
      ...originalEnv,
      DEPLOYMENT_TYPE: 'selfhosted',
    } as typeof env;
    process.env.AFFINE_CHATGPT_SUBSCRIPTION = 'true';

    const sandbox = Sinon.createSandbox();
    t.teardown(() => {
      sandbox.restore();
      globalThis.env = originalEnv;
      if (enabled === undefined) {
        delete process.env.AFFINE_CHATGPT_SUBSCRIPTION;
      } else {
        process.env.AFFINE_CHATGPT_SUBSCRIPTION = enabled;
      }
    });

    const direct = request({ origin: 'http://localhost:3010' });
    t.true(allowsChatGPTSubscription(direct));
    t.true(allowsChatGPTSubscription(request({ origin: 'assets://.' }, '::1')));
    t.false(
      allowsChatGPTSubscription(request({ origin: 'https://example.com' }))
    );
    t.false(allowsChatGPTSubscription(request({ host: 'example.com' })));
    t.false(allowsChatGPTSubscription(request({ forwarded: 'for=192.0.2.1' })));
    t.false(allowsChatGPTSubscription(request({}, '192.0.2.1')));

    sandbox
      .stub(ChatGPTAuth.prototype, 'state')
      .returns({ status: 'connected', planUsageEnabled: true });
    sandbox.stub(ChatGPTAuth.prototype, 'start').resolves({
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    });
    sandbox.stub(ChatGPTAuth.prototype, 'models').resolves([
      {
        id: 'account-model',
        displayName: 'Account Model',
        supportedReasoningEfforts: ['high'],
      },
    ]);
    sandbox
      .stub(ChatGPTAuth.prototype, 'accessToken')
      .resolves('example-token');
    sandbox.stub(ChatGPTAuth.prototype, 'disconnect').resolves();

    const subscription = new ChatGPTSubscription();
    await subscription.start('owner', direct);
    t.deepEqual(subscription.status('other', direct), {
      status: 'unavailable',
    });
    t.throws(() => subscription.start('other', direct));
    for (const effort of ['xhigh', 'ultra']) {
      await t.throwsAsync(
        subscription.setPreference('owner', direct, {
          modelId: 'account-model',
          effort,
        }),
        { message: 'Unavailable ChatGPT model or effort' }
      );
    }
    await subscription.setPreference('owner', direct, {
      modelId: 'account-model',
      effort: 'high',
    });
    t.is(subscription.select('other'), undefined);
    const selected = subscription.select('owner');
    t.truthy(selected);
    t.is(await selected?.getAccessToken(), 'example-token');

    await subscription.disconnect('owner', direct);
    await subscription.start('owner', direct);
    t.throws(() => selected?.getAccessToken(), {
      message: 'ChatGPT subscription is disconnected',
    });
  }
);
