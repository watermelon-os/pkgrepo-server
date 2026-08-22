/**
 * Общие application-контракты, нужные нескольким слоям (не HTTP и не infrastructure).
 * Живут отдельно от app.ts, чтобы нижние слои не зависели от composition root.
 */

export interface Token {
  value: string;
  comment?: string;
  role?: string;
}