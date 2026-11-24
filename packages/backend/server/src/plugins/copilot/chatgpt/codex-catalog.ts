import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

export const chatGPTApplicationName = 'affine-local';

export interface ReasoningMetadata {
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: readonly string[];
}

const modelPage = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      hidden: z.boolean().optional(),
      defaultReasoningEffort: z.string().optional(),
      supportedReasoningEfforts: z.array(
        z.object({ reasoningEffort: z.string().min(1) })
      ),
    })
  ),
  nextCursor: z.string().nullish(),
});

const providerId = 'openai_chatgpt_plan';
const provider = `model_providers.${providerId}`;
const tokenEnvKey = 'AFFINE_CHATGPT_CODEX_ACCESS_TOKEN';
const childEnvironmentKeys = new Set([
  'PATH',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
]);
const argumentsForCatalog = [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  `model_provider="${providerId}"`,
  '-c',
  `${provider}.name="ChatGPT plan"`,
  '-c',
  `${provider}.base_url="https://api.openai.com/v1"`,
  '-c',
  `${provider}.env_key="${tokenEnvKey}"`,
  '-c',
  `${provider}.wire_api="responses"`,
  '-c',
  `${provider}.requires_openai_auth=false`,
  '-c',
  `${provider}.supports_websockets=false`,
];

/** Optional Codex metadata for slugs already present in the account catalog. */
export async function readCodexCatalog(executable: string, token: string) {
  const models = new Map<string, ReasoningMetadata>();
  if (!isAbsolute(executable)) return models;
  const directory = await mkdtemp(join(tmpdir(), 'affine-chatgpt-codex-'));
  try {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        childEnvironmentKeys.has(key.toUpperCase())
      )
    );
    const child = spawn(executable, argumentsForCatalog, {
      // Separate state prevents Codex from using saved logins, projects, or configuration.
      cwd: directory,
      env: { ...environment, CODEX_HOME: directory, [tokenEnvKey]: token },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const closed = new Promise<void>(resolve =>
      child.once('close', () => resolve())
    );

    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Codex catalog timed out.')),
          5000
        ).unref();
        child.once('close', () =>
          reject(new Error('Codex exited before returning its catalog.'))
        );
        child.once('error', reject);
        child.stdin.on('error', reject);
        const send = (message: object) =>
          child.stdin.write(`${JSON.stringify(message)}\n`);
        let messageId = 1;
        let pageCount = 0;
        let readBuffer = '';
        const requestPage = (cursor?: string) =>
          send({
            id: ++messageId,
            method: 'model/list',
            params: { cursor, limit: 100, includeHidden: false },
          });

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          readBuffer += chunk;
          if (readBuffer.length > 2 * 1024 * 1024) {
            reject(new Error('Codex catalog response was too large.'));
            return;
          }
          let newline = readBuffer.indexOf('\n');
          while (newline !== -1) {
            const line = readBuffer.slice(0, newline);
            readBuffer = readBuffer.slice(newline + 1);
            newline = readBuffer.indexOf('\n');
            let reply: { id?: number; result?: unknown };
            try {
              reply = JSON.parse(line);
            } catch {
              continue;
            }
            if (reply?.id !== messageId) continue;
            if (reply.result === undefined) {
              reject(new Error('Codex could not return model metadata.'));
              return;
            }
            if (messageId === 1) {
              send({ method: 'initialized' });
              requestPage();
              continue;
            }

            const page = modelPage.safeParse(reply.result);
            if (!page.success) {
              reject(new Error('Codex returned invalid model metadata.'));
              return;
            }
            for (const item of page.data.data) {
              if (item.hidden) continue;
              models.set(item.model, {
                defaultReasoningEffort: item.defaultReasoningEffort,
                supportedReasoningEfforts: item.supportedReasoningEfforts.map(
                  option => option.reasoningEffort
                ),
              });
            }
            if (page.data.nextCursor && ++pageCount < 5) {
              requestPage(page.data.nextCursor);
            } else {
              resolve();
              return;
            }
          }
        });

        send({
          id: messageId,
          method: 'initialize',
          params: {
            clientInfo: {
              name: chatGPTApplicationName,
              title: 'AFFiNE Local',
              version: '1',
            },
          },
        });
      });
    } finally {
      clearTimeout(timeout);
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await closed;
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  }
  return models;
}
