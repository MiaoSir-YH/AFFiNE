import { Input, notify } from '@affine/component';
import {
  SettingHeader,
  SettingRow,
  SettingWrapper,
} from '@affine/component/setting-components';
import { Button } from '@affine/component/ui/button';
import { RadioGroup } from '@affine/component/ui/radio';
import { AIModelService } from '@affine/core/modules/ai-button';
import { useI18n } from '@affine/i18n';
import { useService } from '@toeverything/infra';
import { useEffect, useState } from 'react';

import { desktopAI } from '../../../../blocksuite/ai/runtime/request/desktop-copilot';
import { ChatGPTSubscriptionPanel } from '../chatgpt-subscription-panel';

export function DesktopAISetting() {
  const t = useI18n();
  const models = useService(AIModelService);
  const api = desktopAI();
  const [mode, setMode] = useState<string>();
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [transcriptionModel, setTranscriptionModel] = useState('');
  const [dialect, setDialect] = useState<'responses' | 'chat_completions'>(
    'chat_completions'
  );
  const [effort, setEffort] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      ?.status()
      .then(status => {
        setMode(status.mode);
        if (status.gateway) {
          setBaseUrl(status.gateway.baseUrl);
          setModel(status.gateway.model);
          setImageModel(status.gateway.imageModel ?? '');
          setTranscriptionModel(status.gateway.transcriptionModel ?? '');
          setDialect(status.gateway.dialect);
          setEffort(status.gateway.effort ?? '');
          setHasKey(true);
        }
      })
      .catch(console.warn);
  }, [api]);

  if (!api) return null;

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.saveGateway({
        baseUrl,
        model,
        imageModel,
        transcriptionModel,
        dialect,
        effort: effort || undefined,
        ...(key ? { apiKey: key } : {}),
      });
      setMode(result.mode);
      await models.refreshDesktopRoute();
      setHasKey(true);
      setKey('');
      setEditing(false);
    } catch {
      notify.error({ title: t['com.affine.ai.desktop.gateway-save-error']() });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const result = await api.useAffine();
      setMode(result.mode);
      await models.refreshDesktopRoute();
    } catch {
      notify.error({ title: t['com.affine.ai.chatgpt.request-failed']() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingHeader title={t['com.affine.ai.desktop.provider-settings']()} />
      <SettingWrapper>
        {models.chatGPT ? (
          <ChatGPTSubscriptionPanel client={models.chatGPT} allowConnect />
        ) : null}
        <SettingRow
          name={t['com.affine.ai.desktop.gateway']()}
          desc={
            mode === 'gateway'
              ? model
              : t['com.affine.ai.desktop.gateway-description']()
          }
        >
          <Button
            data-testid="desktop-ai-gateway-configure"
            onClick={() => setEditing(value => !value)}
          >
            {t[editing ? 'Cancel' : 'com.affine.ai.desktop.configure']()}
          </Button>
        </SettingRow>
        {editing ? (
          <>
            <SettingRow name={t['com.affine.ai.desktop.api-address']()}>
              <Input
                data-testid="desktop-ai-base-url"
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder="https://api.example.com/v1"
              />
            </SettingRow>
            <SettingRow name="API Key">
              <Input
                type="password"
                data-testid="desktop-ai-api-key"
                value={key}
                onChange={setKey}
                placeholder={hasKey ? '••••••••' : undefined}
              />
            </SettingRow>
            <SettingRow name={t['com.affine.ai.desktop.api-format']()}>
              <RadioGroup
                value={dialect}
                onChange={setDialect}
                items={[
                  { value: 'chat_completions', label: 'Chat Completions' },
                  { value: 'responses', label: 'Responses' },
                ]}
              />
            </SettingRow>
            <SettingRow name={t['com.affine.ai.chatgpt.model']()}>
              <Input
                data-testid="desktop-ai-model"
                value={model}
                onChange={setModel}
              />
            </SettingRow>
            <SettingRow name={t['com.affine.ai.chatgpt.effort']()}>
              <Input
                data-testid="desktop-ai-effort"
                value={effort}
                onChange={setEffort}
                placeholder={t['com.affine.ai.chatgpt.automatic']()}
              />
            </SettingRow>
            <SettingRow name={t['com.affine.ai.desktop.image-model']()}>
              <Input
                data-testid="desktop-ai-image-model"
                value={imageModel}
                onChange={setImageModel}
              />
            </SettingRow>
            <SettingRow name={t['com.affine.ai.desktop.transcription-model']()}>
              <Input
                data-testid="desktop-ai-transcription-model"
                value={transcriptionModel}
                onChange={setTranscriptionModel}
              />
            </SettingRow>
            <SettingRow name={t['com.affine.ai.desktop.gateway']()}>
              <Button
                data-testid="desktop-ai-gateway-save"
                disabled={busy || !baseUrl || !model || (!key && !hasKey)}
                onClick={() => void save()}
              >
                {t['com.affine.ai.desktop.save-gateway']()}
              </Button>
            </SettingRow>
          </>
        ) : null}
        {mode === 'gateway' ? (
          <SettingRow name={t['com.affine.ai.desktop.active-provider']()}>
            <Button disabled={busy} onClick={() => void disable()}>
              {t['com.affine.ai.desktop.disable-provider']()}
            </Button>
          </SettingRow>
        ) : null}
      </SettingWrapper>
    </>
  );
}
