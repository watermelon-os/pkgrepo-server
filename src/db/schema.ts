import { sqliteTable, text, integer, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const packages = sqliteTable("packages", {
  name: text("name").primaryKey(),
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

// Спек — файл со своей версией; у имени может быть несколько спеков.
// Содержимое хранится в бд; дедуп — по хэшу содержимого (+имя+версия спека).
// Override перезаписывает запись на месте (id неизменен) — ссылки не ломаются.
export const specs = sqliteTable(
  "specs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name")
      .notNull()
      .references(() => packages.name, { onDelete: "cascade" }),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("specs_name_version_uq").on(table.name, table.version)],
);

export type Spec = typeof specs.$inferSelect;
export type NewSpec = typeof specs.$inferInsert;

export const versions = sqliteTable(
  "versions",
  {
    packageName: text("package_name")
      .notNull()
      .references(() => packages.name, { onDelete: "cascade" }),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    // Спек, которым собран артефакт (история/группировка); nullable.
    specId: integer("spec_id").references(() => specs.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.packageName, table.version] })],
);

export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;
