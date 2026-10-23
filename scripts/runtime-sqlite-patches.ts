export const sqliteBusyTimeoutMs = 10_000;

const pragma = `pragma busy_timeout = ${sqliteBusyTimeoutMs}`;
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
const identifier = "[A-Za-z_$][\\w$]*";
const boundedIdentifier = "[A-Za-z_$][\\w$]{0,80}";
const storeVariable = "$zStore";

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

/**
 * Desktop 3.16.3 / runtime 0.17.0 has one async store-open path:
 *
 *   let migration = await runSqliteSessionMigrationsAsync(db, dbPath, options);
 *   return new SqliteSessionStore(db, dbPath, options, migration);
 *
 * The migration helper restores its 25 ms native wait to 5 s in `finally`.
 * Keep a 10 s steady-state wait on the same connection before the store is
 * handed to callers.
 */
const openAnchor = new RegExp(
  `let (${identifier})=await (${identifier})\\((${identifier}),(${identifier}),(${identifier}\\?\\?\\{lockWaitTimeoutMs:${identifier}\\})\\);return new (${identifier})\\(([^)]*)\\)`,
  "u"
);
const openedAnchor = new RegExp(
  `let (${identifier})=await (${identifier})\\((${identifier}),(${identifier}),(${identifier}\\?\\?\\{lockWaitTimeoutMs:${identifier}\\})\\);(${identifier})\\.exec\\("${escape(pragma)}"\\);`,
  "u"
);
const storeRecovery = new RegExp(
  `let \\${storeVariable}=new (${identifier})\\(([^)]*)\\);${escape(helper)}\\.installSqliteWriteRecovery\\(\\${storeVariable}\\);return \\${storeVariable}`,
  "u"
);

export function hasRuntimeSqliteBusyTimeout(runtime: string): boolean {
  const opened = openedAnchor.exec(runtime);
  if (!opened || opened[6] !== opened[3]) return false;
  const after = runtime.slice(opened.index + opened[0].length, opened.index + opened[0].length + 400);
  return /^(?:return new [A-Za-z_$][\w$]*\([^)]*\)|let \$zStore=new [A-Za-z_$][\w$]*\([^)]*\);)/u.test(after)
    && runtime.split(`.exec("${pragma}")`).length === 2;
}

export function patchRuntimeSqliteBusyTimeout(runtime: string): string {
  if (hasRuntimeSqliteBusyTimeout(runtime)) return runtime;
  const anchor = openAnchor.exec(runtime);
  if (!anchor || count(runtime, new RegExp(openAnchor.source, "gu")) !== 1) {
    throw new Error("ZCode runtime is incompatible with the SQLite busy-timeout patch (store open anchor missing or ambiguous).");
  }
  const [, migration, migrate, db, dbPath, options, store, args] = anchor;
  const patched = runtime.replace(
    anchor[0],
    `let ${migration}=await ${migrate}(${db},${dbPath},${options});${db}.exec("${pragma}");return new ${store}(${args})`
  );
  if (!hasRuntimeSqliteBusyTimeout(patched)) throw new Error("SQLite busy-timeout patch failed postcondition verification.");
  return patched;
}

export function hasRuntimeSqliteWriteRecovery(runtime: string): boolean {
  if (!hasRuntimeSqliteBusyTimeout(runtime)) return false;
  const opened = openedAnchor.exec(runtime);
  if (!opened) return false;
  const after = runtime.slice(opened.index + opened[0].length, opened.index + opened[0].length + 600);
  return count(after, new RegExp(storeRecovery.source, "gu")) === 1
    && runtime.split(`${helper}.pruneSqliteUsage(`).length === 2;
}

/** Keep the native SQL body and transaction; only the maintenance admission moves into our helper. */
function patchUsageCleanup(runtime: string): string {
  const labels = [...runtime.matchAll(new RegExp(`${boundedIdentifier}\\((${boundedIdentifier}),"pruneUsage"\\)`, "gu"))];
  if (labels.length !== 1) throw new Error("SQLite recovery pruneUsage symbol is missing or ambiguous.");
  const name = labels[0]![1]!;
  const prefix = new RegExp(`async function ${escape(name)}\\((${boundedIdentifier}),(${boundedIdentifier})=\\{\\}\\)\\{(?:let|const) (${boundedIdentifier})=\\2\\.beforeTime\\?\\?Date\\.now\\(\\)-[^;]{1,100};`, "gu");
  const starts = [...runtime.matchAll(prefix)];
  if (starts.length !== 1) throw new Error("SQLite recovery cleanup boundary is incompatible.");
  const start = starts[0]!;
  const [, db, options, cutoff] = start;
  const bodyStart = start.index! + start[0].length;
  const tail = new RegExp(`\\}catch\\((${boundedIdentifier})\\)\\{throw ${escape(db!)}\\.exec\\("rollback"\\),\\1\\}\\}`, "u");
  const end = tail.exec(runtime.slice(bodyStart, bodyStart + 4_000));
  if (!end) throw new Error("SQLite recovery cleanup transaction is incompatible.");
  const bodyEnd = bodyStart + end.index + end[0].length - 1;
  const body = runtime.slice(bodyStart, bodyEnd);
  if (/\bawait\b|\byield\b/u.test(body)
    || !body.startsWith(`${db}.exec("begin immediate");try{`)
    || !["model_usage", "turn_usage", "tool_usage"].every(table =>
      body.includes(`${db}.prepare("delete from ${table} where started_at < ?").run(${cutoff})`))
    || !body.includes(`${db}.exec("commit")`)) {
    throw new Error("SQLite recovery cleanup SQL changed; review the native transaction before patching.");
  }
  const replacement = `${start[0]}return ${helper}.pruneSqliteUsage(${db},${options},${cutoff},()=>{${body}})}`;
  return runtime.slice(0, start.index) + replacement + runtime.slice(bodyEnd + 1);
}

export function patchRuntimeSqliteWriteRecovery(runtime: string): string {
  if (hasRuntimeSqliteWriteRecovery(runtime)) return runtime;
  if (runtime.includes(".installSqliteWriteRecovery(") || runtime.includes(".pruneSqliteUsage(")) {
    throw new Error("SQLite recovery patch is partial or ambiguous.");
  }
  if (!hasRuntimeSqliteBusyTimeout(runtime)) throw new Error("SQLite recovery requires the post-migration timeout patch.");
  const opened = openedAnchor.exec(runtime);
  if (!opened) throw new Error("SQLite recovery store-open anchor is missing.");
  const after = runtime.slice(opened.index + opened[0].length);
  const storeReturn = /^return new ([A-Za-z_$][\w$]*)\(([^)]*)\)/u.exec(after);
  if (!storeReturn) throw new Error("SQLite recovery store construction is missing or ambiguous.");
  const patchedOpen = `${opened[0]}let ${storeVariable}=new ${storeReturn[1]}(${storeReturn[2]});${helper}.installSqliteWriteRecovery(${storeVariable});return ${storeVariable}`;
  let patched = runtime.slice(0, opened.index) + patchedOpen + after.slice(storeReturn[0].length);
  patched = patchUsageCleanup(patched);
  if (!hasRuntimeSqliteWriteRecovery(patched)) throw new Error("SQLite recovery patch failed postcondition verification.");
  return patched;
}
