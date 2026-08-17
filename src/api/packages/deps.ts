import type { OrchClient, Token } from "../../types.js";
import type { DatabaseClient } from "../../db/index.js";
import type { Logger } from "../../logger.js";
import { createRepoAdapter, type RepoAdapter } from "../../repoAdapter.js";

export interface PackageApiDeps {
  db: DatabaseClient;
  fsRoot?: string;
  commonTestUrl?: string;
  commonBuildUrl?: string;
  orch?: OrchClient;
  logger?: Logger;
  tokens?: Token[];
  repoAdapter?: RepoAdapter;
}

/** Адаптер из зависимостей либо детерминированный по умолчанию (без утилит) для тестов. */
export function resolveAdapter(deps: PackageApiDeps, logger: Logger): RepoAdapter {
  return deps.repoAdapter ?? createRepoAdapter({ useUtilities: false, logger });
}