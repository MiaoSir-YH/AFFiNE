import { notify } from '@affine/component';
import { SettingRow } from '@affine/component/setting-components';
import { Button } from '@affine/component/ui/button';
import type { AIModelService } from '@affine/core/modules/ai-button';
import { useI18n } from '@affine/i18n';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export function ChatGPTSubscriptionPanel({
  client,
  allowConnect = false,
}: {
  client: NonNullable<AIModelService['chatGPT']>;
  allowConnect?: boolean;
}) {
  const t = useI18n();
  const status = useSyncExternalStore(
    useCallback(onChange => client.connection.subscribe(onChange), [client]),
    () => client.connection.value.status
  );
  const busy = useSyncExternalStore(
    useCallback(onChange => client.busy.subscribe(onChange), [client]),
    () => client.busy.value
  );
  const notifyFailure = useCallback(() => {
    notify.error({ title: t['com.affine.ai.chatgpt.request-failed']() });
  }, [t]);

  useEffect(() => {
    client.refresh().catch(() => notifyFailure());
  }, [client, notifyFailure]);

  if (status !== 'connected' && !allowConnect) return null;

  const connected = status === 'connected';
  const authorizing = status === 'authorizing';
  const action = connected || authorizing ? 'disconnect' : 'connect';
  const label = connected
    ? t['com.affine.ai.chatgpt.disconnect']()
    : authorizing
      ? t['com.affine.ai.chatgpt.cancel']()
      : t['com.affine.ai.chatgpt.connect']();
  const onAction = async () => {
    try {
      await client[action]();
      if (client.connection.value.status === 'error') notifyFailure();
    } catch {
      notifyFailure();
    }
  };

  return (
    <SettingRow
      name={t['com.affine.ai.chatgpt.provider']()}
      desc={
        authorizing ? t['com.affine.ai.chatgpt.connect-pending']() : undefined
      }
    >
      <Button
        data-testid={`chatgpt-subscription-${action}`}
        disabled={busy}
        onClick={() => void onAction()}
      >
        {label}
      </Button>
    </SettingRow>
  );
}
