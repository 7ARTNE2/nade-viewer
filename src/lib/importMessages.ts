import type { ImportStatus } from '../types/domain';

type Translate = (english: string, russian: string) => string;

/**
 * Localized labels for the backend import/update stages (`ImportStatus.stage`).
 * Used as a fallback when a specific backend message is not recognised.
 */
const IMPORT_STAGE_LABELS: Record<string, readonly [string, string]> = {
  idle: ['Ready', 'Готово'],
  checking_update: ['Checking online library', 'Проверка онлайн-библиотеки'],
  preparing: ['Preparing import', 'Подготовка импорта'],
  reading: ['Reading source file', 'Чтение исходного файла'],
  downloading: ['Downloading online library', 'Скачивание онлайн-библиотеки'],
  decompressing: [
    'Decompressing and verifying library',
    'Распаковка и проверка библиотеки',
  ],
  importing: ['Importing lineups', 'Импорт раскидок'],
  extracting_screenshots: ['Extracting screenshots', 'Извлечение скриншотов'],
  finalizing: ['Finalizing import', 'Завершение импорта'],
  done: ['Import complete', 'Импорт завершён'],
  cancelled: ['Import cancelled', 'Импорт отменён'],
  error: ['Import failed', 'Ошибка импорта'],
};

/**
 * Localized labels for the exact English status messages the backend emits.
 * Preferred over the stage label because a single stage can carry several
 * messages (for example "Indexing Core Nades" vs "Indexing grenades").
 */
const IMPORT_STATUS_MESSAGES: Record<string, readonly [string, string]> = {
  Ready: ['Ready', 'Готово'],
  'Reading import': ['Reading import', 'Чтение файла импорта'],
  'Import state is unavailable': [
    'Import state is unavailable',
    'Состояние импорта недоступно',
  ],
  'An import is already running': [
    'An import is already running',
    'Импорт уже выполняется',
  ],
  'Checking online library': [
    'Checking online library',
    'Проверка онлайн-библиотеки',
  ],
  'Downloading online library': [
    'Downloading online library',
    'Скачивание онлайн-библиотеки',
  ],
  'Decompressing and verifying online library': [
    'Decompressing and verifying online library',
    'Распаковка и проверка онлайн-библиотеки',
  ],
  'Finalizing verified library update': [
    'Finalizing verified library update',
    'Завершение проверенного обновления библиотеки',
  ],
  'Streaming grenades into local storage': [
    'Streaming grenades into local storage',
    'Запись раскидок в локальное хранилище',
  ],
  'Import complete': ['Import complete', 'Импорт завершён'],
  'Preparing parser workspace import': [
    'Preparing parser workspace import',
    'Подготовка импорта рабочей базы парсера',
  ],
  'Importing parser workspace': [
    'Importing parser workspace',
    'Импорт рабочей базы парсера',
  ],
  'Parser workspace import complete': [
    'Parser workspace import complete',
    'Импорт рабочей базы парсера завершён',
  ],
  'Import cancelled': ['Import cancelled', 'Импорт отменён'],
  'Library download cancelled': [
    'Library download cancelled',
    'Скачивание библиотеки отменено',
  ],
  'Reading screenshot archive': [
    'Reading screenshot archive',
    'Чтение архива скриншотов',
  ],
  'Importing screenshots': ['Importing screenshots', 'Импорт скриншотов'],
  'Extracting screenshots': ['Extracting screenshots', 'Извлечение скриншотов'],
  'Screenshot archive import complete': [
    'Screenshot archive import complete',
    'Импорт архива скриншотов завершён',
  ],
  'Indexing Core Nades': ['Indexing Core Nades', 'Индексация Core Nades'],
  'Indexing grenades': ['Indexing grenades', 'Индексация гранат'],
  'Preparing Core Nades snapshot': [
    'Preparing Core Nades snapshot',
    'Подготовка снимка Core Nades',
  ],
  'Core Nades snapshot imported': [
    'Core Nades snapshot imported',
    'Снимок Core Nades импортирован',
  ],
  'Preparing local database': [
    'Preparing local database',
    'Подготовка локальной базы данных',
  ],
};

/**
 * Localized labels for the backend import/update error codes returned by
 * `AppError::Import { code, .. }`.
 */
const IMPORT_ERROR_LABELS: Record<string, readonly [string, string]> = {
  import_cancelled: ['Import cancelled', 'Импорт отменён'],
  import_already_running: [
    'An import is already running',
    'Импорт уже выполняется',
  ],
  import_state_unavailable: [
    'Import state is unavailable',
    'Состояние импорта недоступно',
  ],
  file_unavailable: [
    'The library file cannot be opened',
    'Не удалось открыть файл библиотеки',
  ],
  invalid_json: [
    'The JSON file is invalid',
    'JSON-файл содержит некорректные данные',
  ],
  invalid_messagepack: [
    'The MessagePack file is invalid',
    'MessagePack-файл содержит некорректные данные',
  ],
  invalid_top_level: [
    'The top-level JSON or MessagePack value must be an object',
    'Верхний уровень JSON или MessagePack должен быть объектом',
  ],
  ambiguous_format: [
    'The file mixes two import formats',
    'В файле смешаны два формата импорта',
  ],
  unsupported_format: [
    'Expected grenade_index, Core Nades JSON/MessagePack, or a Nadegrid screenshot ZIP',
    'Ожидается grenade_index, JSON/MessagePack Core Nades или ZIP-архив скриншотов Nadegrid',
  ],
  missing_version: [
    'Core Nades JSON or MessagePack requires version 1',
    'Для Core Nades JSON или MessagePack требуется версия 1',
  ],
  invalid_version: [
    'The top-level version must be an integer',
    'Версия верхнего уровня должна быть целым числом',
  ],
  unsupported_version: [
    'This JSON or MessagePack version is not supported',
    'Эта версия JSON или MessagePack не поддерживается',
  ],
  invalid_canonical_format: [
    'Invalid grenade_index structure',
    'Некорректная структура grenade_index',
  ],
  invalid_core_format: [
    'Invalid Core Nades structure',
    'Некорректная структура Core Nades',
  ],
  library_manifest_unavailable: [
    'The online library manifest is unavailable',
    'Манифест онлайн-библиотеки недоступен',
  ],
  library_update_invalid: [
    'The online library manifest is invalid',
    'Манифест онлайн-библиотеки содержит ошибку',
  ],
  library_download_failed: [
    'The online library could not be downloaded',
    'Не удалось скачать онлайн-библиотеку',
  ],
  library_size_mismatch: [
    'The downloaded library size is incorrect',
    'Размер скачанной библиотеки не совпадает',
  ],
  library_hash_mismatch: [
    'The downloaded library failed its integrity check',
    'Проверка целостности скачанной библиотеки не пройдена',
  ],
  library_download_cancelled: [
    'Library download cancelled',
    'Скачивание библиотеки отменено',
  ],
  library_already_current: [
    'The online library is already current',
    'Онлайн-библиотека уже обновлена',
  ],
  library_decompression_failed: [
    'The online library could not be unpacked',
    'Не удалось распаковать онлайн-библиотеку',
  ],
  library_uncompressed_hash_mismatch: [
    'The unpacked library failed its integrity check',
    'Проверка целостности распакованной библиотеки не пройдена',
  ],
  library_uncompressed_size_mismatch: [
    'The unpacked library size is incorrect',
    'Размер распакованной библиотеки не совпадает',
  ],
};

/** Localized label for a backend stage, or `null` when the stage is unknown. */
function importStageLabel(
  stage: string | null | undefined,
  tr: Translate,
): string | null {
  if (!stage) return null;
  const label = IMPORT_STAGE_LABELS[stage];
  return label ? tr(label[0], label[1]) : null;
}

/** Localized label for a backend error code, or `null` when unknown. */
export function importErrorLabel(
  code: string | null | undefined,
  tr: Translate,
): string | null {
  if (!code) return null;
  const label = IMPORT_ERROR_LABELS[code];
  return label ? tr(label[0], label[1]) : null;
}

/**
 * Localized text for the current status: the exact backend message when it is
 * known, otherwise the stage label, otherwise the raw backend message.
 */
export function importStatusMessage(
  status: ImportStatus | null | undefined,
  tr: Translate,
): string | null {
  if (!status) return null;
  const message = status.message?.trim();
  if (message) {
    const known = IMPORT_STATUS_MESSAGES[message];
    if (known) return tr(known[0], known[1]);
  }
  return importStageLabel(status.stage, tr) ?? message ?? null;
}

/** The error `code` from an unknown thrown value, or `null`. */
export function importErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** The error `message` from an unknown thrown value, or `null`. */
export function importErrorDetail(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  }
  return null;
}
