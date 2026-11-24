import {
  PreconditionStrategy,
  registerAffineCommand,
} from '@affine/core/commands';
import { I18n } from '@affine/i18n';
import { track } from '@affine/track';
import { useService } from '@toeverything/infra';
import { useEffect } from 'react';

import { NavigatorService } from '../services/navigator';

export function useRegisterNavigationCommands() {
  const navigator = useService(NavigatorService).navigator;
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      registerAffineCommand({
        id: 'affine:shortcut-history-go-back',
        category: 'affine:general',
        preconditionStrategy: PreconditionStrategy.Never,
        icon: 'none',
        label: () => I18n['com.affine.keyboardShortcuts.goBack'](),
        keyBinding: {
          binding: '$mod+[',
        },
        run() {
          track.$.cmdk.general.goBack();

          navigator.back();
        },
      })
    );
    unsubs.push(
      registerAffineCommand({
        id: 'affine:shortcut-history-go-forward',
        category: 'affine:general',
        preconditionStrategy: PreconditionStrategy.Never,
        icon: 'none',
        label: () => I18n['com.affine.keyboardShortcuts.goForward'](),
        keyBinding: {
          binding: '$mod+]',
        },
        run() {
          track.$.cmdk.general.goForward();

          navigator.forward();
        },
      })
    );

    return () => {
      unsubs.forEach(unsub => unsub());
    };
  }, [navigator]);
}
