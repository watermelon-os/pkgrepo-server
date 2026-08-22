import { z } from "zod";

export const nameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);
export const versionSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._+~-]+$/);

// Имя и версия объявляются клиентом (промежуточный «тупой» поток); валидация
// содержимого выполняется цепочкой разбора артефакта (утилиты → шаблон имени).
export const createBodySchema = z.object({
  name: nameSchema,
  version: versionSchema.optional(),
  file: z.string().optional(),
  repositories: z.array(z.string().min(1)).optional(),
});

export const versionBodySchema = z.object({
  version: versionSchema,
  file: z.string().optional(),
});

export const versionUpdateBodySchema = z.object({
  file: z.string().optional(),
});

export const repositoriesBodySchema = z.object({
  repositories: z.array(z.string().min(1)).min(1),
});
