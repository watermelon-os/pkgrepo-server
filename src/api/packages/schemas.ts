import { z } from "zod";

export const nameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);
export const versionSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);

export const createBodySchema = z.object({
  name: nameSchema,
  version: versionSchema.optional(),
  file: z.string().optional(),
  testUrl: z.string().url().optional(),
  buildUrl: z.string().url().optional(),
  repositories: z.array(z.string().min(1)).optional(),
  // PRS-07: не ошибка при несовпадении имени — сервер размещает файл
  // под фактическим именем/версией из метаданных (переименовывает сам).
  resolveName: z.boolean().optional(),
});

export const updateBodySchema = z.object({
  testUrl: z.string().url().optional(),
  buildUrl: z.string().url().optional(),
});

export const versionBodySchema = z.object({
  version: versionSchema,
  file: z.string().optional(),
  resolveName: z.boolean().optional(),
});

export const versionUpdateBodySchema = z.object({
  file: z.string().optional(),
  resolveName: z.boolean().optional(),
});

export const repositoriesBodySchema = z.object({
  repositories: z.array(z.string().min(1)).min(1),
});

export const runBodySchema = z.object({
  testUrl: z.string().url().optional(),
  buildUrl: z.string().url().optional(),
  version: versionSchema.optional(),
});