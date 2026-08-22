import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

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
