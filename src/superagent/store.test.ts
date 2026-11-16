/** The Store's generated working sets (store.ts): the column a database created before it gains on open, and the index its query uses. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import type { Decision } from "./core/index.js";
import { Store } from "./store.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "swarm-store-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** A Decision as the router records one; `triggerIds` and thread say little, as nothing reads them here. */
function decision(id: string, patch: Partial<Decision> = {}): Decision {
  return { id, evalId: "eval", threadKey: "local:t", triggerIds: ["t"], policyVersion: "1", at: "2026-11-16T00:00:00Z",
    kind: "unavailable", reason: [{ code: "timeout" }], strength: "explicit", ...patch };
}
const plan = (store: Store, sql: string, ...parameters: (string | number)[]): string[] =>
  store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => String(row.detail));
/** The statement `unroutedDecisions` runs, caught as the Store prepares it, so the plan below is its own query's. */
function caughtUnrouted(store: Store): string {
  const prepare = store.db.prepare.bind(store.db);
  let caught = "";
  store.db.prepare = (sql: string) => { if (sql.includes("decision_unrouted")) caught = sql; return prepare(sql); };
  try { store.read.unroutedDecisions(50); } finally { store.db.prepare = prepare; }
  return caught;
}

test("a database created before the column gains it on open, and lists the same requests", () => {
  const path = join(directory, "superagent.db");
  // As an earlier version left it: the decision table without a generated column.
  const older = new DatabaseSync(path);
  older.exec("CREATE TABLE decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL)");
  older.prepare("INSERT INTO decision VALUES (?,?,?)").run("stored", "local:t", JSON.stringify(decision("stored")));
  older.close();

  const store = new Store(path);
  const names = store.db.prepare("SELECT name FROM pragma_table_xinfo('decision')").all().map((row) => String(row.name));
  assert.ok(names.includes("unrouted"), names.join(","));
  assert.deepEqual(store.read.unroutedDecisions().map((item) => item.id), ["stored"], "the stored row fills the column from its JSON");
  // Opened again, the column is left as it is.
  store.close();
  const again = new Store(path);
  assert.deepEqual(again.read.unroutedDecisions().map((item) => item.id), ["stored"]);
  again.close();
});

test("the list reads the partial index instead of the whole decision table, and dismissing takes a request off it", () => {
  const store = new Store(join(directory, "superagent.db"));
  const noisy = [
    decision("ignored", { kind: "ignore" }),
    decision("inferred", { strength: "inferred" }),
    decision("restarted", { reason: [{ code: "policyChanged" }] }),
    decision("later-timeout", { reason: [{ code: "routed" }, { code: "timeout" }] })
  ];
  for (const item of noisy) store.decisions.save(item);
  store.decisions.save(decision("one"));
  store.decisions.save(decision("two"));
  assert.deepEqual(store.read.unroutedDecisions().map((item) => item.id), ["two", "one"], "newest first, and only those");
  // The very statement `unroutedDecisions` ran above, so dropping its column or `INDEXED BY` hint fails here.
  const caught = caughtUnrouted(store);
  assert.match(caught, /INDEXED BY decision_unrouted/, caught);
  const details = plan(store, caught, 50);
  assert.ok(details.some((detail) => detail.includes("decision_unrouted")), details.join(" | "));
  assert.ok(details.every((detail) => !detail.includes("SCAN decision")), "no table scan");

  store.decisions.save({ ...store.decisions.get("two")!, dismissed: true });
  assert.deepEqual(store.read.unroutedDecisions().map((item) => item.id), ["one"]);
  store.close();
});
