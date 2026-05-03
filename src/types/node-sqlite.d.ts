declare module "node:sqlite" {
  export class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown | undefined;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
