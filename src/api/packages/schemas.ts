import { z } from "zod";

export const nameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);
export const versionSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);
// Имя загружаемого ФАЙЛА (не пакета): нужно фолбэк-парсеру имени файла.
export const filenameSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/);

// Имя и версия НЕ задаются в запросе — разбираются из самого артефакта
// (утилита пакетной системы → парсер имени файла). NM-06, PRS-06.
export const createBodySchema = z.object({
  file: z.string().optional(),
  filename: filenameSchema.optional(),
  repositories: z.array(z.string().min(1)).optional(),
  specVersion: versionSchema.optional(),
  // NM-04: перезапись существующей версии «втупую» с пересчетом хэша.
  override: z.boolean().optional(),
});

export const versionBodySchema = z.object({
  file: z.string().optional(),
  filename: filenameSchema.optional(),
  specVersion: versionSchema.optional(),
  override: z.boolean().optional(),
});

export const versionUpdateBodySchema = z.object({
  file: z.string().optional(),
  filename: filenameSchema.optional(),
});

export const repositoriesBodySchema = z.object({
  repositories: z.array(z.string().min(1)).min(1),
});
