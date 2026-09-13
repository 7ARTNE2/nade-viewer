import { invoke } from '@tauri-apps/api/core';
import type { ComponentType } from 'react';
import { FileSearch, type LucideIcon } from 'lucide-react';
import NadeParserTool from '../components/NadeParserTool';

export type ToolPluginInfo = {
  installed: boolean;
  path: string | null;
  version: string | null;
};

type LocalizedText = readonly [english: string, russian: string];

export type ToolPluginDefinition = {
  id: string;
  name: string;
  category: LocalizedText;
  description: LocalizedText;
  features: readonly LocalizedText[];
  icon: LucideIcon;
  getInfo: () => Promise<ToolPluginInfo>;
  View: ComponentType<{ refreshImports?: () => Promise<void> }>;
};

// Only registered, implemented plugins belong in the catalog. Each plugin owns
// its commands and detail view; the Tools page only handles listing/navigation.
export const toolPlugins: readonly ToolPluginDefinition[] = [
  {
    id: 'nade-parser',
    name: 'Nade Parser',
    category: ['Demo analysis', 'Анализ демо'],
    description: [
      'Extract grenade lineups from demos, remove duplicates and export a library for the Viewer.',
      'Извлекайте раскидки из демо, убирайте повторы и экспортируйте библиотеку для Viewer.',
    ],
    features: [
      ['Demo parsing', 'Разбор демо'],
      ['Deduplication', 'Дедупликация'],
      ['JSON / MPK export', 'Экспорт JSON / MPK'],
    ],
    icon: FileSearch,
    getInfo: () => invoke<ToolPluginInfo>('get_nade_parser_info'),
    View: NadeParserTool,
  },
];
