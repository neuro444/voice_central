// Minimal ambient types for node:sqlite, scoped to what src/lib/db.ts,
// src/lib/users.ts, and scripts/add-user.mjs actually use.
//
// The runtime module ships in Node itself (confirmed working on the Node
// version this project runs) -- this file only exists because the pinned
// `@types/node@^20` predates node:sqlite's real type declarations. If
// @types/node is ever bumped past the version that added these, this file
// becomes redundant and can be deleted.
declare module "node:sqlite" {
  export interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
