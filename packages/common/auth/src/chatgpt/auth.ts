import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';

import { chatGPTCallbackHost, chatGPTCallbackPath } from './callback';

export interface ReasoningMetadata {
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: readonly string[];
}

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const dynamicClient = 'dynamic_agent_client';
const planScope = 'chatgpt.tokens.use.direct';
const authorizeForMs = 5 * 60 * 1000;
const requestTimeoutMs = 15 * 1000;
const refreshEarlyMs = 60 * 1000;
// The Responses endpoint accepts a narrower enum than the Codex model catalog.
const responsesReasoningEfforts = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().positive().finite(),
  scope: z.string().optional(),
  id_token: z.string().min(1).optional(),
});
const modelsSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      visibility: z.string(),
      default_reasoning_level: z.string().nullish().catch(undefined),
      supported_reasoning_levels: z
        .array(
          z.object({ effort: z.string(), description: z.string().optional() })
        )
        .optional()
        .catch(undefined),
    })
  ),
});
const oauthErrorSchema = z.object({ error: z.string() });
const invalidRefreshErrors = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

type TokenResponse = z.infer<typeof tokensSchema>;

interface Registration {
  clientId: string;
  subject: string;
  email?: string;
}

interface Session {
  registration: Registration;
  tokens: TokenResponse;
  expiresAt: number;
}

interface Authorization {
  server: ReturnType<typeof createServer>;
  state: string;
  nonce: string;
  verifier: string;
  registration?: Registration;
  redirectUri: string;
  authorizationUrl: string;
  simplifiedChinese?: boolean;
  timer?: NodeJS.Timeout;
  callback?: Promise<void>;
}

export interface ChatGPTAuthState {
  status: 'disconnected' | 'authorizing' | 'connected' | 'error';
  planUsageEnabled: boolean;
  email?: string;
  error?: string;
}

export interface ChatGPTModel extends ReasoningMetadata {
  id: string;
  displayName: string;
}

function normalizeModelReasoning(model: ChatGPTModel): ChatGPTModel {
  const supportedReasoningEfforts = model.supportedReasoningEfforts?.filter(
    effort => responsesReasoningEfforts.has(effort)
  );
  const defaultEffort = model.defaultReasoningEffort;
  return {
    ...model,
    supportedReasoningEfforts,
    defaultReasoningEffort:
      defaultEffort &&
      responsesReasoningEfforts.has(defaultEffort) &&
      (supportedReasoningEfforts?.includes(defaultEffort) ?? true)
        ? defaultEffort
        : undefined,
  };
}

class OAuthFailure extends Error {
  constructor(readonly code?: string) {
    super('OpenAI could not complete ChatGPT authorization.');
  }
}

function hasPlanAccess(scope?: string) {
  const granted = new Set(scope?.split(/\s+/));
  return granted.has(planScope) && granted.has('resource.invoke');
}

function randomSecret() {
  return randomBytes(32).toString('base64url');
}

function sameState(actual: string | null, expected: string) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function respond(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Type': 'text/plain; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(message);
}

async function loadHostId(directory: string) {
  const path = join(directory, 'chatgpt-host-id');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `urn:uuid:${randomUUID()}`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const id = (await readFile(path, 'utf8')).trim();
  if (
    !/^urn:uuid:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      id
    )
  ) {
    throw new Error('The local ChatGPT host identifier is invalid.');
  }
  return id;
}

/** Credentials belong to one user's local server process and are kept in memory. */
export class ChatGPTAuth {
  readonly #fetch: typeof fetch;
  readonly #hostId: () => Promise<string>;
  readonly #keys: ReturnType<typeof createRemoteJWKSet>;
  readonly #applicationName: string;
  readonly #loadModelMetadata?: (
    token: string
  ) => Promise<ReadonlyMap<string, ReasoningMetadata>>;
  #modelMetadata?: {
    expiresAt: number;
    models: Promise<ReadonlyMap<string, ReasoningMetadata>>;
  };
  #registration?: Registration;
  #session?: Session;
  #attempt?: Authorization;
  #starting?: Promise<{ authorizationUrl: string }>;
  #refreshing?: Promise<Session>;
  #disconnecting?: Promise<void>;
  #error?: string;

  constructor(
    options: {
      fetcher?: typeof fetch;
      hostId?: string;
      dataDirectory?: string;
      applicationName?: string;
      loadModelMetadata?: (
        token: string
      ) => Promise<ReadonlyMap<string, ReasoningMetadata>>;
    } = {}
  ) {
    this.#fetch = options.fetcher ?? fetch;
    this.#applicationName = options.applicationName ?? 'AFFiNE';
    this.#loadModelMetadata = options.loadModelMetadata;
    const { hostId, dataDirectory = join(homedir(), '.affine') } = options;
    this.#hostId = hostId
      ? async () => hostId
      : () => loadHostId(dataDirectory);
    this.#keys = createRemoteJWKSet(
      new URL(`${issuer}/.well-known/jwks.json`),
      {
        [customFetch]: this.#fetch,
      }
    );
  }

  state(): ChatGPTAuthState {
    if (this.#session && !this.#disconnecting) {
      return {
        status: 'connected',
        planUsageEnabled: true,
        email: this.#session.registration.email,
      };
    }
    if (this.#attempt || this.#starting)
      return { status: 'authorizing', planUsageEnabled: false };
    if (this.#error)
      return { status: 'error', planUsageEnabled: false, error: this.#error };
    return { status: 'disconnected', planUsageEnabled: false };
  }

  async start(
    options: { newAccount?: boolean; simplifiedChinese?: boolean } = {}
  ) {
    if (this.#session || this.#disconnecting) {
      throw new Error(
        'Disconnect the current ChatGPT account before signing in again.'
      );
    }
    if (this.#starting) return this.#starting;
    if (this.#attempt)
      return { authorizationUrl: this.#attempt.authorizationUrl };

    this.#starting = this.#beginAuthorization(
      options.newAccount,
      options.simplifiedChinese
    );
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #beginAuthorization(newAccount?: boolean, simplifiedChinese?: boolean) {
    this.#error = undefined;
    const hostId = await this.#hostId();
    const server = createServer(
      { requestTimeout: requestTimeoutMs },
      (request, response) => {
        this.#receiveCallback(server, request, response);
      }
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, chatGPTCallbackHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || this.#disconnecting) {
      server.close();
      throw new Error('Could not start the local ChatGPT sign-in callback.');
    }

    const state = randomSecret();
    const nonce = randomSecret();
    const verifier = randomSecret();
    const redirectUri = `http://${chatGPTCallbackHost}:${address.port}${chatGPTCallbackPath}`;
    const registration = newAccount ? undefined : this.#registration;
    const authorizationUrl = new URL(`${issuer}/api/accounts/authorize`);
    authorizationUrl.search = new URLSearchParams({
      client_id: registration?.clientId ?? dynamicClient,
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      resource,
      scope: `openid profile email offline_access resource.invoke ${planScope}`,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    if (registration) {
      authorizationUrl.searchParams.set('prompt', 'consent');
    } else {
      authorizationUrl.searchParams.set(
        'agent_name_hint',
        this.#applicationName
      );
    }

    const attempt: Authorization = {
      server,
      state,
      nonce,
      verifier,
      registration,
      redirectUri,
      authorizationUrl: authorizationUrl.href,
      simplifiedChinese,
    };
    attempt.timer = setTimeout(() => {
      if (this.#attempt === attempt) {
        this.#error = 'ChatGPT sign-in timed out. Start a new sign-in.';
        this.#closeAttempt(attempt);
      }
    }, authorizeForMs).unref();
    server.on('error', () => {
      if (this.#attempt === attempt) {
        this.#error = 'The local ChatGPT sign-in callback failed.';
        this.#closeAttempt(attempt);
      }
    });
    server.unref();
    this.#attempt = attempt;
    return { authorizationUrl: attempt.authorizationUrl };
  }

  #receiveCallback(
    server: Authorization['server'],
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const attempt = this.#attempt;
    if (!attempt || attempt.server !== server || attempt.callback) {
      respond(response, 410, 'There is no pending ChatGPT sign-in.');
      return;
    }
    const callback = new URL(attempt.redirectUri);
    if (
      request.method !== 'GET' ||
      request.headers.host !== callback.host ||
      !request.url?.startsWith(`${chatGPTCallbackPath}?`)
    ) {
      respond(response, 404, 'ChatGPT sign-in callback not found.');
      return;
    }
    const params = new URLSearchParams(
      request.url.slice(chatGPTCallbackPath.length + 1)
    );
    if (
      params.getAll('state').length !== 1 ||
      !sameState(params.get('state'), attempt.state)
    ) {
      respond(response, 400, 'ChatGPT sign-in state did not match.');
      return;
    }

    attempt.callback = this.#completeAuthorization(attempt, params, response);
  }

  async #completeAuthorization(
    attempt: Authorization,
    params: URLSearchParams,
    response: ServerResponse
  ) {
    let session: Session | undefined;
    try {
      if (params.has('error'))
        throw new Error('ChatGPT sign-in was declined or failed.');
      const code = params.get('code');
      const callbackClient = params.get('client_id');
      const clientId = attempt.registration?.clientId ?? callbackClient;
      if (
        !code ||
        params.getAll('code').length !== 1 ||
        !clientId ||
        clientId === dynamicClient ||
        params.getAll('client_id').length > 1 ||
        (callbackClient !== null && callbackClient !== clientId)
      ) {
        throw new Error('ChatGPT did not return a valid authorization.');
      }

      const tokens = await this.#requestTokens(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: attempt.verifier,
          redirect_uri: attempt.redirectUri,
          resource,
        })
      );
      const registration = await this.#verifyIdentity(
        tokens.id_token,
        clientId,
        attempt.nonce
      );
      if (
        attempt.registration &&
        attempt.registration.subject !== registration.subject
      ) {
        throw new Error('ChatGPT signed in to a different account.');
      }
      session = {
        registration,
        tokens,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      };
      if (this.#attempt !== attempt || this.#disconnecting) {
        throw new Error('The local ChatGPT sign-in was cancelled.');
      }
      this.#registration = registration;
      if (!hasPlanAccess(tokens.scope)) {
        throw new Error('Permission to use your ChatGPT plan was not granted.');
      }
      if (!tokens.refresh_token) {
        throw new Error(
          'OpenAI did not return a renewable ChatGPT connection.'
        );
      }

      this.#session = session;
      respond(
        response,
        200,
        attempt.simplifiedChinese
          ? '已连接 ChatGPT。你可以关闭此标签页，返回 AFFiNE 选择模型。'
          : 'ChatGPT is connected. You can close this tab and return to AFFiNE.'
      );
    } catch (error) {
      if (this.#attempt === attempt) {
        this.#error =
          error instanceof Error ? error.message : 'ChatGPT sign-in failed.';
      }
      respond(
        response,
        400,
        attempt.simplifiedChinese
          ? 'ChatGPT 授权失败。请返回 AFFiNE 重试。'
          : 'ChatGPT sign-in failed. Return to AFFiNE for details.'
      );
      if (session && this.#session !== session)
        await this.#revoke(session).catch(() => undefined);
    } finally {
      this.#closeAttempt(attempt);
    }
  }

  async #verifyIdentity(
    token: string | undefined,
    clientId: string,
    nonce: string
  ) {
    if (token) {
      try {
        const { payload } = await jwtVerify(token, this.#keys, {
          algorithms: ['RS256'],
          audience: clientId,
          issuer,
          requiredClaims: ['sub', 'exp', 'nonce'],
        });
        if (
          payload.sub &&
          (payload.azp === undefined || payload.azp === clientId) &&
          typeof payload.nonce === 'string' &&
          sameState(payload.nonce, nonce)
        ) {
          return {
            clientId,
            subject: payload.sub,
            email:
              typeof payload.email === 'string' ? payload.email : undefined,
          };
        }
      } catch {
        // Authentication responses and verification errors may contain credentials.
      }
    }
    throw new Error('OpenAI could not verify the ChatGPT account identity.');
  }

  #closeAttempt(attempt: Authorization) {
    clearTimeout(attempt.timer);
    if (this.#attempt === attempt) this.#attempt = undefined;
    attempt.server.close();
  }

  async #requestTokens(body: URLSearchParams) {
    const response = await this.#request(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      body,
    });
    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = oauthErrorSchema.safeParse(result);
      throw new OAuthFailure(parsed.success ? parsed.data.error : undefined);
    }
    const parsed = tokensSchema.safeParse(result);
    if (!parsed.success) throw new OAuthFailure();
    return parsed.data;
  }

  async #request(url: string, init: RequestInit) {
    try {
      return await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new Error('Could not reach OpenAI for ChatGPT authorization.');
    }
  }

  async accessToken() {
    const session = this.#session;
    if (!session || this.#disconnecting) {
      throw new Error('Connect ChatGPT and approve use of your plan first.');
    }
    if (session.expiresAt - Date.now() > refreshEarlyMs)
      return session.tokens.access_token;

    this.#refreshing ??= this.#refresh(session).finally(() => {
      this.#refreshing = undefined;
    });
    const refreshed = await this.#refreshing;
    if (this.#disconnecting || this.#session !== refreshed) {
      throw new Error('The ChatGPT account has been disconnected.');
    }
    return refreshed.tokens.access_token;
  }

  async #refresh(session: Session) {
    const refreshToken = session.tokens.refresh_token;
    if (!refreshToken) throw new OAuthFailure();
    let tokens: TokenResponse;
    try {
      tokens = await this.#requestTokens(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: session.registration.clientId,
          refresh_token: refreshToken,
          resource,
        })
      );
    } catch (error) {
      if (
        error instanceof OAuthFailure &&
        invalidRefreshErrors.has(error.code ?? '')
      ) {
        this.#session = undefined;
        this.#error =
          'The ChatGPT connection expired or was revoked. Sign in again.';
        throw new Error(this.#error);
      }
      throw error;
    }
    tokens.scope ??= session.tokens.scope;
    const refreshed = {
      registration: session.registration,
      tokens,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    if (!hasPlanAccess(tokens.scope) || !tokens.refresh_token) {
      this.#session = undefined;
      this.#error =
        'OpenAI could not renew access to your ChatGPT plan. Sign in again.';
      await this.#revoke(refreshed).catch(() => undefined);
      throw new Error(this.#error);
    }
    this.#session = refreshed;
    return refreshed;
  }

  async models(): Promise<ChatGPTModel[]> {
    const token = await this.accessToken();
    const registration = this.#session?.registration;
    const response = await this.#request(`${resource}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (
      !registration ||
      this.#session?.registration !== registration ||
      this.#disconnecting
    ) {
      throw new Error('The ChatGPT account has been disconnected.');
    }
    const parsed = modelsSchema.safeParse(body);
    if (!response.ok || !parsed.success) {
      throw new Error(
        'OpenAI did not return the models available to this ChatGPT account.'
      );
    }
    const models: ChatGPTModel[] = parsed.data.models
      .filter(model => model.visibility === 'list')
      .map(model => ({
        id: model.slug,
        displayName: model.display_name,
        defaultReasoningEffort: model.default_reasoning_level ?? undefined,
        supportedReasoningEfforts: model.supported_reasoning_levels?.map(
          option => option.effort
        ),
      }));
    const loadMetadata = this.#loadModelMetadata;
    if (
      !loadMetadata ||
      !models.some(model => model.supportedReasoningEfforts === undefined)
    ) {
      return models.map(normalizeModelReasoning);
    }

    if (!this.#modelMetadata || this.#modelMetadata.expiresAt <= Date.now()) {
      this.#modelMetadata = {
        expiresAt: Date.now() + 5 * 60 * 1000,
        models: loadMetadata(token).catch(() => new Map()),
      };
    }
    const catalog = await this.#modelMetadata.models;
    if (this.#session?.registration !== registration || this.#disconnecting) {
      throw new Error('The ChatGPT account has been disconnected.');
    }
    return models.map(model => {
      const metadata = catalog.get(model.id);
      return normalizeModelReasoning({
        ...model,
        defaultReasoningEffort:
          model.defaultReasoningEffort ?? metadata?.defaultReasoningEffort,
        supportedReasoningEfforts:
          model.supportedReasoningEfforts ??
          metadata?.supportedReasoningEfforts,
      });
    });
  }

  async disconnect() {
    this.#disconnecting ??= this.#endSession().finally(() => {
      this.#disconnecting = undefined;
    });
    return this.#disconnecting;
  }

  async #endSession() {
    const pending = this.#attempt;
    if (pending) this.#closeAttempt(pending);
    await this.#starting?.catch(() => undefined);
    await pending?.callback;
    await this.#refreshing?.catch(() => undefined);

    const session = this.#session;
    this.#session = undefined;
    this.#modelMetadata = undefined;
    this.#error = undefined;
    if (!session) return;
    try {
      await this.#revoke(session);
    } catch {
      this.#error =
        'ChatGPT was disconnected locally. Revoke the connection in ChatGPT settings to confirm.';
    }
  }

  async #revoke(session: Session) {
    const token = session.tokens.refresh_token;
    if (!token) return;
    // Listed in OpenAI's public OpenID Connect discovery document.
    const response = await this.#request(
      `${issuer}/api/accounts/oauth/revoke`,
      {
        method: 'POST',
        body: new URLSearchParams({
          token,
          token_type_hint: 'refresh_token',
          client_id: session.registration.clientId,
        }),
      }
    );
    if (response.status !== 200) throw new OAuthFailure();
  }
}
