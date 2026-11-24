import type { AIToolsConfigService } from '@affine/core/modules/ai-button';
import type { AIModelService } from '@affine/core/modules/ai-button/services/models';
import { getOrCreateI18n, I18n } from '@affine/i18n';
import {
  menu,
  popMenu,
  popupTargetFromElement,
} from '@blocksuite/affine/components/context-menu';
import { LoadingIcon } from '@blocksuite/affine/components/icons';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import type { NotificationService } from '@blocksuite/affine-shared/services';
import {
  AiOutlineIcon,
  ArrowDownSmallIcon,
  CloudWorkspaceIcon,
  DoneIcon,
  LockIcon,
  ThinkingIcon,
} from '@blocksuite/icons/lit';
import { ShadowlessElement } from '@blocksuite/std';
import { autoPlacement, offset, shift } from '@floating-ui/dom';
import { computed } from '@preact/signals-core';
import { css, html } from 'lit';
import { property } from 'lit/decorators.js';

const modelSubMenuMiddleware = [
  autoPlacement({ allowedPlacements: ['right-start', 'left-start'] }),
  offset({ mainAxis: 4, crossAxis: 0 }),
  shift({ crossAxis: true, padding: 8 }),
];

const thinkingLevelLabels: Readonly<Record<string, () => string>> = {
  none: I18n['com.affine.ai.chatgpt.effort-none'],
  minimal: I18n['com.affine.ai.chatgpt.effort-minimal'],
  low: I18n['com.affine.ai.chatgpt.effort-low'],
  medium: I18n['com.affine.ai.chatgpt.effort-medium'],
  high: I18n['com.affine.ai.chatgpt.effort-high'],
  xhigh: I18n['com.affine.ai.chatgpt.effort-xhigh'],
  max: I18n['com.affine.ai.chatgpt.effort-max'],
};

export class ChatInputPreference extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    .chat-input-preference-trigger {
      display: flex;
      align-items: center;
      padding: 0px 4px;
      color: var(--affine-v2-icon-primary);
      transition: all 0.23s ease;
      border-radius: 4px;
      background: transparent;
      border: none;
      cursor: pointer;
    }
    .chat-input-preference-trigger:hover {
      background-color: var(--affine-v2-layer-background-hoverOverlay);
    }
    .chat-input-preference-trigger-label {
      font-size: 14px;
      line-height: 22px;
      font-weight: 500;
      padding: 0px 4px;
      max-width: min(230px, 36vw);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-input-preference-trigger-icon {
      font-size: 20px;
      line-height: 0;
    }
    .preference-action {
      white-space: nowrap;
      min-width: 220px;
    }
    .ai-active-model-name {
      margin-left: 40px;
      color: ${unsafeCSSVarV2('text/secondary')};
      font-size: 14px;
      line-height: 22px;
    }
    .ai-model-prefix {
      width: 20px;
      height: 20px;
    }
    .ai-model-prefix svg {
      color: ${unsafeCSSVarV2('icon/activated')};
    }
    .ai-model-postfix {
      width: 20px;
      height: 20px;
    }
    .ai-model-postfix svg:hover {
      color: ${unsafeCSSVarV2('icon/activated')};
    }
    .ai-model-version {
      margin-right: 40px;
      color: ${unsafeCSSVarV2('text/tertiary')};
      font-size: 12px;
      line-height: 20px;
    }
  `;

  // --------- extended thinking props start ---------
  @property({ attribute: false })
  accessor extendedThinking: boolean = false;

  @property({ attribute: false })
  accessor onExtendedThinkingChange:
    | ((extendedThinking: boolean) => void)
    | undefined;
  // --------- extended thinking props end ---------

  @property({ attribute: false })
  accessor toolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor aiModelService!: AIModelService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor onAISubscribe!: () => Promise<void>;

  private readonly model = computed(() =>
    this.aiModelService.models.value.find(
      model => model.id === this.aiModelService.modelId.value
    )
  );

  override connectedCallback() {
    super.connectedCallback();
    const i18n = getOrCreateI18n();
    const update = () => this.requestUpdate();
    i18n.on('languageChanged', update);
    this.disposables.add(() => i18n.off('languageChanged', update));
  }

  private get subscriptionModel() {
    const chatGPT = this.aiModelService.chatGPT;
    const modelId = chatGPT?.connection.value.preference?.modelId;
    return chatGPT?.models.value.find(model => model.id === modelId);
  }

  private updateChatGPT(update: Promise<void>) {
    update.catch(() =>
      this.notificationService.toast(
        I18n['com.affine.ai.chatgpt.request-failed']()
      )
    );
  }

  private connectionItems(): ReturnType<typeof menu.action>[] {
    const chatGPT = this.aiModelService.chatGPT;
    if (!chatGPT) return [];
    switch (chatGPT.connection.value.status) {
      case 'unavailable':
        return [];
      case 'disconnected':
      case 'error':
        return [
          menu.action({
            name: I18n['com.affine.ai.chatgpt.connect'](),
            info:
              chatGPT.connection.value.status === 'error'
                ? html`${I18n['com.affine.ai.chatgpt.auth-failed']()}`
                : undefined,
            prefix: AiOutlineIcon(),
            select: () => this.updateChatGPT(chatGPT.connect()),
          }),
        ];
      case 'authorizing':
        return [
          menu.action({
            name: I18n['com.affine.ai.chatgpt.connect-pending'](),
            prefix: LoadingIcon({ size: '20px' }),
            select: () => false,
          }),
          menu.action({
            name: I18n['com.affine.ai.chatgpt.cancel'](),
            select: () => this.updateChatGPT(chatGPT.disconnect()),
          }),
        ];
      case 'connected':
        return [];
    }
  }

  openPreference(e: Event) {
    const element = e.currentTarget;
    if (!(element instanceof HTMLElement)) return;
    const preferenceItems = [];
    const searchItems = [];
    const chatGPT = this.aiModelService.chatGPT;
    const subscriptionModel = this.subscriptionModel;
    const subscriptionPreference = chatGPT?.connection.value.preference;
    const gateway = this.aiModelService.desktopGateway.value;

    const selectManaged = (id?: string) => {
      if (chatGPT && subscriptionPreference) {
        this.updateChatGPT(
          chatGPT.setPreference(null).then(() => {
            this.aiModelService.setModel(id);
          })
        );
        return;
      }
      this.aiModelService.setModel(id);
    };

    if (gateway) {
      preferenceItems.push(
        menu.action({
          name: I18n['com.affine.ai.chatgpt.model'](),
          prefix: AiOutlineIcon(),
          info: html`<span class="ai-active-model-name"
            >${gateway.model}</span
          >`,
          select: () => false,
        })
      );
    } else if (
      this.aiModelService.models.value.length ||
      chatGPT?.connection.value.status === 'connected'
    ) {
      preferenceItems.push(
        menu.subMenu({
          name: I18n['com.affine.ai.chatgpt.model'](),
          prefix: AiOutlineIcon(),
          middleware: modelSubMenuMiddleware,
          postfix: html`
            <span class="ai-active-model-name">
              ${
                subscriptionModel?.displayName ??
                this.model.value?.name ??
                I18n['com.affine.ai.chatgpt.automatic']()
              }
            </span>
          `,
          options: {
            items: [
              menu.action({
                name: I18n['com.affine.ai.chatgpt.automatic'](),
                prefix: html`
                  <div class="ai-model-prefix">
                    ${
                      !subscriptionPreference &&
                      !this.aiModelService.modelId.value
                        ? DoneIcon()
                        : undefined
                    }
                  </div>
                `,
                select: () => selectManaged(),
              }),
              ...this.aiModelService.models.value.map(model =>
                menu.action({
                  name: model.category,
                  info: html`
                    <span class="ai-model-version">${model.version}</span>
                  `,
                  prefix: html`
                    <div class="ai-model-prefix">
                      ${
                        !subscriptionPreference &&
                        model.id === this.aiModelService.modelId.value
                          ? DoneIcon()
                          : undefined
                      }
                    </div>
                  `,
                  postfix: html`
                    <div class="ai-model-postfix">
                      ${model.available ? undefined : LockIcon()}
                    </div>
                  `,
                  select: () => {
                    if (!model.available) {
                      this.notificationService.toast(
                        I18n[
                          'com.affine.ai.chatgpt.affine-subscription-required'
                        ]()
                      );
                      this.onAISubscribe().catch(console.error);
                      return;
                    }
                    selectManaged(model.id);
                  },
                })
              ),
              ...(chatGPT?.connection.value.status === 'connected'
                ? [
                    menu.group({
                      items: chatGPT.models.value.length
                        ? chatGPT.models.value.map(model =>
                            menu.action({
                              name: model.displayName,
                              testId: `chatgpt-model-${model.id}`,
                              prefix: html`
                                <div class="ai-model-prefix">
                                  ${
                                    model.id === subscriptionPreference?.modelId
                                      ? DoneIcon()
                                      : undefined
                                  }
                                </div>
                              `,
                              select: () =>
                                this.updateChatGPT(
                                  chatGPT.setPreference(
                                    model.id,
                                    model.id === subscriptionPreference?.modelId
                                      ? subscriptionPreference.effort
                                      : undefined
                                  )
                                ),
                            })
                          )
                        : [
                            menu.action({
                              name: I18n[
                                'com.affine.ai.chatgpt.reload-models'
                              ](),
                              info: html`
                                ${
                                  chatGPT.modelLoadFailed.value
                                    ? I18n[
                                        'com.affine.ai.chatgpt.request-failed'
                                      ]()
                                    : I18n[
                                        'com.affine.ai.chatgpt.model-empty'
                                      ]()
                                }
                              `,
                              prefix: chatGPT.busy.value
                                ? LoadingIcon({ size: '20px' })
                                : undefined,
                              select: () =>
                                this.updateChatGPT(chatGPT.refresh()),
                            }),
                          ],
                    }),
                  ]
                : []),
            ],
          },
        })
      );
    }

    if (gateway) {
      const effort = gateway.effort;
      preferenceItems.push(
        menu.action({
          name: I18n['com.affine.ai.chatgpt.effort'](),
          prefix: ThinkingIcon(),
          info: html`<span class="ai-active-model-name"
            >${
              effort && Object.hasOwn(thinkingLevelLabels, effort)
                ? thinkingLevelLabels[effort]()
                : I18n['com.affine.ai.chatgpt.effort-default']()
            }</span
          >`,
          select: () => false,
        })
      );
    } else if (chatGPT && subscriptionModel) {
      const currentEffort = subscriptionPreference?.effort;
      const defaultEffort = subscriptionModel.defaultReasoningEffort;
      const hasLabel = (level: string) =>
        Object.hasOwn(thinkingLevelLabels, level);
      const levels = [
        undefined,
        ...(subscriptionModel.supportedReasoningEfforts ?? []).filter(hasLabel),
      ];
      const label = (level?: string) =>
        level && hasLabel(level)
          ? thinkingLevelLabels[level]()
          : I18n['com.affine.ai.chatgpt.effort-default']();
      preferenceItems.push(
        menu.subMenu({
          name: I18n['com.affine.ai.chatgpt.effort'](),
          prefix: ThinkingIcon(),
          middleware: modelSubMenuMiddleware,
          postfix: html`<span class="ai-active-model-name"
            >${label(currentEffort)}</span
          >`,
          options: {
            items: levels.map(level =>
              menu.action({
                name: label(level),
                info:
                  !level && defaultEffort && hasLabel(defaultEffort)
                    ? html`${label(defaultEffort)}`
                    : undefined,
                testId: `chatgpt-effort-${level ?? 'default'}`,
                prefix: html`
                  <div class="ai-model-prefix">
                    ${currentEffort === level ? DoneIcon() : undefined}
                  </div>
                `,
                select: () =>
                  this.updateChatGPT(
                    chatGPT.setPreference(subscriptionModel.id, level)
                  ),
              })
            ),
          },
        })
      );
    } else {
      preferenceItems.push(
        menu.toggleSwitch({
          name: I18n['com.affine.ai.chatgpt.extended-thinking'](),
          prefix: ThinkingIcon(),
          on: this.extendedThinking,
          onChange: (value: boolean) => this.onExtendedThinkingChange?.(value),
          class: { 'preference-action': true },
        })
      );
    }

    preferenceItems.push(...this.connectionItems());

    searchItems.push(
      menu.toggleSwitch({
        name: I18n['com.affine.ai.chatgpt.workspace-docs'](),
        prefix: CloudWorkspaceIcon(),
        on:
          !!this.toolsConfigService.config.value.searchWorkspace &&
          !!this.toolsConfigService.config.value.readingDocs,
        onChange: (value: boolean) =>
          this.toolsConfigService.setConfig({
            searchWorkspace: value,
            readingDocs: value,
          }),
        class: { 'preference-action': true },
      })
    );

    popMenu(popupTargetFromElement(element), {
      options: {
        items: [
          menu.group({
            items: [...preferenceItems],
          }),
          menu.group({
            items: [...searchItems],
          }),
        ],
        testId: 'chat-input-preference',
      },
    });
  }

  override render() {
    const chatGPT = this.aiModelService.chatGPT;
    const authorizing = chatGPT?.connection.value.status === 'authorizing';
    const busy = authorizing || chatGPT?.busy.value;
    return html`<button
      @click=${this.openPreference}
      data-testid="chat-input-preference-trigger"
      class="chat-input-preference-trigger"
      aria-haspopup="menu"
      aria-busy=${!!busy}
    >
      <span class="chat-input-preference-trigger-label" aria-live="polite">
        ${
          authorizing
            ? I18n['com.affine.ai.chatgpt.connect-pending']()
            : (this.aiModelService.desktopGateway.value?.model ??
              this.subscriptionModel?.displayName ??
              this.model.value?.category ??
              I18n['com.affine.ai.chatgpt.automatic']())
        }
      </span>
      <span class="chat-input-preference-trigger-icon">
        ${busy ? LoadingIcon({ size: '20px' }) : ArrowDownSmallIcon()}
      </span>
    </button>`;
  }
}
