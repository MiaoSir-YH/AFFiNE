import { createHash } from 'node:crypto';

import test from 'ava';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ChatGPTAuth } from '../../plugins/copilot/chatgpt/auth';

const clientId = 'oaiapp_test';
const planScope = 'offline_access resource.invoke chatgpt.tokens.use.direct';
const hostId = 'urn:uuid:20e30c01-f0c2-4975-af23-928fbf7c346c';

async function fixture(options: { scope?: string; nonce?: string } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: 'test-key',
    alg: 'RS256',
  };
  const grants: URLSearchParams[] = [];
  const revocations: URLSearchParams[] = [];
  let authorization: URL;
  const fetcher: typeof fetch = async (input, request) => {
    const url = new URL(String(input));
    if (url.href === 'https://auth.openai.com/.well-known/jwks.json') {
      return Response.json({ keys: [publicJwk] });
    }
    if (url.href === 'https://auth.openai.com/api/accounts/oauth/token') {
      const body = new URLSearchParams(String(request?.body));
      grants.push(body);
      if (body.get('grant_type') === 'refresh_token') {
        return Response.json({
          expires_in: 3600,
          token_type: 'Bearer',
          access_token: 'renewed-access-token',
          refresh_token: 'renewed-refresh-token',
        });
      }
      const idToken = await new SignJWT({
        email: 'test@example.com',
        nonce: options.nonce ?? authorization.searchParams.get('nonce'),
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(url.origin)
        .setAudience(clientId)
        .setSubject('local-demo-user')
        .setExpirationTime('1h')
        .sign(privateKey);
      return Response.json({
        expires_in: 1,
        token_type: 'Bearer',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: idToken,
        scope: options.scope ?? planScope,
      });
    }
    if (url.href === 'https://api.openai.com/v1/models') {
      if (
        new Headers(request?.headers).get('Authorization') !==
        'Bearer renewed-access-token'
      ) {
        return new Response(null, { status: 401 });
      }
      return Response.json({
        models: [
          {
            slug: 'model-visible',
            display_name: 'Visible',
            visibility: 'list',
            default_reasoning_level: 'low',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'ultra' },
              { effort: 'high' },
              { effort: 'future-value' },
            ],
          },
          {
            slug: 'model-with-codex-default',
            display_name: 'Codex Default',
            visibility: 'list',
            default_reasoning_level: 'ultra',
            supported_reasoning_levels: [
              { effort: 'ultra' },
              { effort: 'max' },
            ],
          },
          { slug: 'model-hidden', display_name: 'Hidden', visibility: 'hide' },
        ],
      });
    }
    if (url.href === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      revocations.push(new URLSearchParams(String(request?.body)));
      return new Response();
    }
    throw new Error('Unexpected URL');
  };

  const auth = new ChatGPTAuth({ fetcher, hostId });
  authorization = new URL((await auth.start()).authorizationUrl);
  function complete(state = authorization.searchParams.get('state')!) {
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      code: 'test-code',
      client_id: clientId,
      state,
    }).toString();
    return fetch(callback);
  }
  return { auth, authorization, complete, grants, revocations };
}

test('connects via a verified local callback and shares one in-flight token refresh', async t => {
  const { auth, authorization, complete, grants, revocations } =
    await fixture();
  try {
    t.is(authorization.origin, 'https://auth.openai.com');
    t.is(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
    t.is(authorization.searchParams.get('ext_agent_host_id'), hostId);
    t.is(
      new URL(authorization.searchParams.get('redirect_uri')!).hostname,
      '127.0.0.1'
    );
    t.is((await complete('invalid-state')).status, 400);
    t.is(grants.length, 0);
    t.is(auth.state().status, 'authorizing');

    t.is((await complete()).status, 200);
    t.deepEqual(auth.state(), {
      status: 'connected',
      email: 'test@example.com',
      planUsageEnabled: true,
    });
    t.is(
      grants[0].get('redirect_uri'),
      authorization.searchParams.get('redirect_uri')
    );
    t.is(grants[0].get('client_id'), clientId);
    t.is(
      createHash('sha256')
        .update(grants[0].get('code_verifier')!)
        .digest('base64url'),
      authorization.searchParams.get('code_challenge')!
    );

    const [token, models] = await Promise.all([
      auth.accessToken(),
      auth.models(),
    ]);
    t.is(token, 'renewed-access-token');
    t.deepEqual(models, [
      {
        id: 'model-visible',
        displayName: 'Visible',
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: ['low', 'high'],
      },
      {
        id: 'model-with-codex-default',
        displayName: 'Codex Default',
        defaultReasoningEffort: undefined,
        supportedReasoningEfforts: ['max'],
      },
    ]);
    t.is(grants.length, 2);
    t.is(grants[1].get('refresh_token'), 'refresh-token');

    await auth.disconnect();
    t.is(revocations[0].get('token'), 'renewed-refresh-token');
    t.is(auth.state().status, 'disconnected');
    await t.throwsAsync(auth.accessToken());
  } finally {
    await auth.disconnect();
  }
});

test('blocks the connection when OpenAI has not granted use of the plan', async t => {
  const { auth, complete } = await fixture({
    scope: 'openid email profile offline_access',
  });
  try {
    t.is((await complete()).status, 400);
    const state = auth.state();
    t.is(state.status, 'error');
    t.false(state.planUsageEnabled);
    t.regex(state.error ?? '', /permission/i);
    await t.throwsAsync(auth.accessToken());
  } finally {
    await auth.disconnect();
  }
});

test('rejects an ID token even with a valid signature when its nonce does not match', async t => {
  const { auth, complete } = await fixture({ nonce: 'wrong-nonce' });
  try {
    t.is((await complete()).status, 400);
    t.is(auth.state().status, 'error');
    await t.throwsAsync(auth.accessToken());
  } finally {
    await auth.disconnect();
  }
});
