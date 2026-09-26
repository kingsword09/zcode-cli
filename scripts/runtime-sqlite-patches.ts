export const sqliteBusyTimeoutMs = 10_000;

const pragma = `pragma busy_timeout = ${sqliteBusyTimeoutMs}`;
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
const identifier = "[A-Za-z_$][\\w$]*";
const boundedIdentifier = "[A-Za-z_$][\\w$]{0,80}";

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

/** Both open paths must retain their steady-state timeout after migration. */
export function hasRuntimeSqliteBusyTimeout(runtime: string): boolean {
  const recovery = escape(`,${helper}.installSqliteWriteRecovery(`);
  const sync = new RegExp(`try\\{${identifier}!==${identifier}&&\\(${identifier}\\(this\\.db,this\\.dbPath,${identifier}\\),this\\.db\\.exec\\("${pragma}"\\)(?:${recovery}this\\))?\\)\\}catch`, "gu");
  const startup = new RegExp(`try\\{return await ${identifier}\\((${identifier})\\.db,\\1\\.dbPath,${identifier}\\),\\1\\.db\\.exec\\("${pragma}"\\)(?:${recovery}\\1\\))?,\\1\\}catch`, "gu");
  return count(runtime, sync) === 1 && count(runtime, startup) === 1;
}

export function patchRuntimeSqliteBusyTimeout(runtime: string): string {
  if (hasRuntimeSqliteBusyTimeout(runtime)) return runtime;
  const sync = /try\{([A-Za-z_$][\w$]*)!==([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\(this\.db,this\.dbPath,([A-Za-z_$][\w$]*)\)\}catch/gu;
  const startup = /try\{return await ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.db,\2\.dbPath,([A-Za-z_$][\w$]*)\),\2\}catch/gu;
  if (count(runtime, sync) !== 1 || count(runtime, startup) !== 1) {
    throw new Error("ZCode runtime is incompatible with the SQLite busy-timeout patch (store migration anchors missing or ambiguous).");
  }
  const patched = runtime.replace(sync, (_match, mode, deferred, migrate, timeout) =>
    `try{${mode}!==${deferred}&&(${migrate}(this.db,this.dbPath,${timeout}),this.db.exec("${pragma}"))}catch`
  ).replace(startup, (_match, migrate, store, options) =>
    `try{return await ${migrate}(${store}.db,${store}.dbPath,${options}),${store}.db.exec("${pragma}"),${store}}catch`
  );
  if (!hasRuntimeSqliteBusyTimeout(patched)) throw new Error("SQLite busy-timeout patch failed postcondition verification.");
  return patched;
}

export function hasRuntimeSqliteWriteRecovery(runtime: string): boolean {
  const sync = `${helper}.installSqliteWriteRecovery(this)`;
  const startup = new RegExp(`${escape(`.db.exec("${pragma}"),${helper}.installSqliteWriteRecovery(`)}(${identifier})\\),\\1\\}catch`, "gu");
  return hasRuntimeSqliteBusyTimeout(runtime)
    && runtime.split(sync).length === 2
    && count(runtime, startup) === 1
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
  const timeout = new RegExp(`(${identifier})\\.db\\.exec\\("${pragma}"\\)`, "gu");
  if (count(runtime, timeout) !== 2) throw new Error("SQLite recovery open boundaries are ambiguous.");
  let patched = runtime.replace(timeout, (call, store) => `${call},${helper}.installSqliteWriteRecovery(${store})`);
  patched = patchUsageCleanup(patched);
  if (!hasRuntimeSqliteWriteRecovery(patched)) throw new Error("SQLite recovery patch failed postcondition verification.");
  return patched;
}
