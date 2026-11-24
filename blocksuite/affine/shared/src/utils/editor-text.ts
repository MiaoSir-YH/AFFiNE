import { signal } from '@preact/signals-core';

const translateEditorText = signal<(text: string) => string>(text => text);

/** Standalone BlockSuite displays the source text until its host supplies a translator. */
export function setEditorTextTranslator(translator: (text: string) => string) {
  translateEditorText.value = translator;
}

export function editorText(text: string): string;
export function editorText(text: string | undefined): string | undefined;
export function editorText(text: string | undefined) {
  return text === undefined ? undefined : translateEditorText.value(text);
}
