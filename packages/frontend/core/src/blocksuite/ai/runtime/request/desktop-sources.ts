import type { AIToolsConfig } from '@affine/core/modules/ai-button';
import type { DocsSearchService } from '@affine/core/modules/docs-search';
import { firstValueFrom, timeout } from 'rxjs';

import type { AIActionOptions } from './action-definitions';

export async function resolveDesktopSources(
  docsSearch: DocsSearchService,
  options: AIActionOptions
) {
  const toolsConfig = options.toolsConfig as AIToolsConfig | undefined;
  const selected = Array.isArray(options.desktopSourceIds)
    ? options.desktopSourceIds.filter(
        (id): id is string => typeof id === 'string'
      )
    : [];
  const explicit = [
    ...new Set([
      ...selected,
      ...(options.docId && toolsConfig?.readingDocs ? [options.docId] : []),
    ]),
  ].slice(0, 8);
  const snippets = await Promise.all(
    explicit.map(async docId => {
      const { nodes } = await docsSearch.indexer.search(
        'block',
        {
          type: 'match',
          field: 'docId',
          match: docId,
        },
        {
          fields: ['content'],
          prefer: 'local',
          pagination: { skip: 0, limit: 45 },
        }
      );
      return {
        id: docId,
        content: nodes
          .flatMap(node => node.fields.content ?? [])
          .join('\n')
          .slice(0, 10_000),
      };
    })
  );
  if (
    !selected.length &&
    toolsConfig?.searchWorkspace &&
    options.input?.trim()
  ) {
    const results = await firstValueFrom(
      docsSearch
        .search$(options.input.trim().slice(0, 500), 'local')
        .pipe(timeout(4000))
    ).catch(() => []);
    for (const item of results.slice(0, 5)) {
      if (!explicit.includes(item.docId) && item.blockContent) {
        snippets.push({
          id: item.docId,
          content: [item.title, item.blockContent].join('\n').slice(0, 2500),
        });
      }
    }
  }
  return snippets.filter(source => source.content.trim());
}
