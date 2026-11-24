// @vitest-environment happy-dom
import { registerAffineLanguageCommands } from '@affine/core/commands';
import { Framework, LiveData } from '@toeverything/infra';
import { expect, test } from 'vitest';

import { CommandsQuickSearchSession } from './commands';

test('updates command labels and search results when the display language changes', () => {
  const currentLanguageKey$ = new LiveData('en');
  const framework = new Framework();
  framework.entity(
    CommandsQuickSearchSession,
    () =>
      new CommandsQuickSearchSession(
        { globalContext: { docMode: { $: new LiveData(undefined) } } } as never,
        { i18n: { currentLanguageKey$ } } as never
      )
  );

  const unregister = registerAffineLanguageCommands({
    i18n: {
      languageList: [{ key: 'da', name: 'Danish', originalName: 'dansk' }],
      currentLanguage$: {
        get value() {
          return { key: currentLanguageKey$.value };
        },
      },
    } as never,
    t: {
      'com.affine.cmdk.affine.display-language.to': () =>
        currentLanguageKey$.value === 'zh-Hans'
          ? '更改显示语言为'
          : 'Change display language to',
    } as never,
  });

  const session = framework.provider().createEntity(CommandsQuickSearchSession);
  const subscription = session.items$.subscribe();
  const firstTitle = () => {
    const label = session.items$.value[0]?.label;
    if (
      typeof label === 'object' &&
      'title' in label &&
      typeof label.title === 'string'
    ) {
      return label.title.replace(/<\/?b>/g, '');
    }
    return undefined;
  };
  try {
    session.query('dansk');
    expect(firstTitle()).toBe('Change display language to dansk');

    currentLanguageKey$.next('zh-Hans');
    expect(firstTitle()).toBe('更改显示语言为 dansk');

    session.query('更改显示语言');
    expect(firstTitle()).toBe('更改显示语言为 dansk');
  } finally {
    subscription.unsubscribe();
    unregister();
    session.dispose();
  }
});
