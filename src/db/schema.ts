import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;

export const packages = sqliteTable("packages", {
  name: text("name").primaryKey(),
  testUrl: text("test_url"),
  buildUrl: text("build_url"),
  repositories: text("repositories", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const repositories = sqliteTable("repositories", {
  name: text("name").primaryKey(),
  path: text("path").notNull(),
  type: text("type").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;

export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;

export const versions = sqliteTable(
  "versions",
  {
    packageName: text("package_name")
      .notNull()
      .references(() => packages.name, { onDelete: "cascade" }),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.packageName, table.version] })],
);

export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;

export const testJournal = sqliteTable("test_journal", {
  id: text("id").primaryKey(),
  packageName: text("package_name")
    .notNull()
    .references(() => packages.name, { onDelete: "cascade" }),
  version: text("version").notNull(),
  status: text("status").notNull(),
  invalid: integer("invalid", { mode: "boolean" }).notNull().default(false),
  body: text("body"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type TestJournal = typeof testJournal.$inferSelect;
export type NewTestJournal = typeof testJournal.$inferInsert;

export const buildJournal = sqliteTable("build_journal", {
  id: text("id").primaryKey(),
  packageName: text("package_name")
    .notNull()
    .references(() => packages.name, { onDelete: "cascade" }),
  version: text("version").notNull(),
  resultVersion: text("result_version"),
  status: text("status").notNull(),
  invalid: integer("invalid", { mode: "boolean" }).notNull().default(false),
  body: text("body"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type BuildJournal = typeof buildJournal.$inferSelect;
export type NewBuildJournal = typeof buildJournal.$inferInsert;