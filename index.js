/**
 * Host half of `@local/dsh-session-delete`.
 *
 * Exposes one authenticated exact Fetch route on the shared `/api` channel:
 *   POST /api/session-delete   body: { sessionId }
 *
 * Deleting a session here is a destructive, irreversible operation that the
 * shipped Host API intentionally does not offer, so this bundle implements its
 * own removal:
 *   1. drop the session from every Workspace accounting slot
 *      (`workspaceRegistry.list()` → `detachSession`, plus idempotent
 *      `unpinSession` / `unarchiveSession`),
 *   2. remove the durable JSONL session-log directory
 *      (`~/.dsh/sessions/<project-key>/<session-id>/`),
 *   3. remove the projection-cache record
 *      (`~/.dsh/storages/session_projcache/sessions/<session-id>.json`).
 *
 * `ctx.connection.fetch.register` is the official escape hatch the shared
 * `/api` dispatcher checks *before* the Typert Gateway interceptor, so the
 * route never collides with the generated `commands/*`, `goals/*`,
 * `workspace/*` namespaces and still rides the same Host/Origin + browser
 * authentication as every other `/api` request.
 */
import { access, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Route the client half calls. */
export const ENDPOINT_PATH = "/api/session-delete";

/* DSH home path resolution, kept self-contained so the bundle has no runtime
 * dependency on `@deepseek-ai/dsh-home-paths` (which may not be resolvable
 * from every profile install): explicit $DSH_HOME wins, else ~/.dsh. */
function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim().length > 0) return resolve(env.trim());
	return resolve(join(homedir(), ".dsh"));
}

/**
 * Encode an arbitrary string as one safe path segment (mirror of
 * `dsh-session-persistence-jsonl`'s internal `encodeSegment`). A SessionId is
 * an unvalidated branded string, so this neutralizes `../`, absolute paths,
 * NUL and separators before any filesystem use.
 * @param raw - the string to encode.
 * @returns the escaped single path segment.
 */
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

/**
 * Build the readable directory key for a project path (mirror of the JSONL
 * backend's internal `projectKey`): filesystem/drive separators become `-`,
 * unsafe code units use the same `~XXXX` escape as session ids.
 * @param cwd - the session's project directory.
 * @returns a filesystem-safe project directory name.
 */
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Absolute path of the JSONL session root (`~/.dsh/sessions`). */
function sessionRoot() {
	return resolve(join(dshHome(), "sessions"));
}

/** Absolute path of one session's log directory. A session without a known
 * project directory follows the backend's own `_no-cwd` convention
 * (`projectDir(root, undefined)`), so orphaned rows (a projection-cache record
 * whose log is already gone) never crash the deletion path. */
function sessionLogDir(sessionId, cwd) {
	const project = cwd === void 0 || cwd.length === 0 ? "_no-cwd" : projectKey(cwd);
	return join(sessionRoot(), project, encodeSegment(sessionId));
}

/** Absolute path of one session's projection-cache record. */
function projectionCachePath(sessionId) {
	return join(resolve(join(dshHome(), "storages")), "session_projcache", "sessions", `${encodeSegment(sessionId)}.json`);
}

/**
 * Delete a session's durable artifacts on disk. Missing targets are ignored so
 * the operation is idempotent and never crashes on a partially-cleaned state.
 * @param sessionId - the session to remove.
 * @param cwd - the session's project directory (from its header).
 * @returns the set of artifact paths that existed and were removed.
 */
async function removeSessionArtifacts(sessionId, cwd) {
	const removed = [];

	const dir = sessionLogDir(sessionId, cwd);
	const dirExisted = await exists(dir);
	if (dirExisted) await rm(dir, { recursive: true, force: true });
	if (dirExisted) removed.push(dir);

	const cache = projectionCachePath(sessionId);
	const cacheExisted = await exists(cache);
	if (cacheExisted) await rm(cache, { force: true });
	if (cacheExisted) removed.push(cache);

	return removed;
}

/** True when a path exists (file or directory). Errors other than absence propagate. */
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Drop the session from the durable Workspace accounting. Idempotent: an id
 * absent from a workspace account, from the archive set, or from the pin set
 * resolves without writing.
 * @param ctx - Host context exposing `workspaceRegistry`.
 * @param sessionId - the session being deleted.
 */
async function removeWorkspaceReferences(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0) return;
	// The registry-global archive/pin sets are independent of the per-workspace
	// accounting slot; remove the id from all three.
	for (const workspace of registry.list()) {
		if (workspace.sessionIds.includes(sessionId)) {
			await workspace.detachSession(sessionId);
		}
	}
	await registry.unpinSession(sessionId);
	await registry.unarchiveSession(sessionId);
}

/**
 * Resolve a session's project directory from the authoritative sources:
 * the live in-memory store first, then the durable persistence `stat` header.
 * Returns `undefined` when the session is unknown.
 */
async function resolveSessionCwd(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	if (sessions !== void 0) {
		const live = sessions.get(sessionId);
		if (live?.header?.cwd !== void 0) return live.header.cwd;
	}
	const persistence = ctx.get("sessionPersistence");
	if (persistence !== void 0) {
		try {
			const snapshot = await persistence.stat(sessionId);
			if (snapshot?.header?.cwd !== void 0) return snapshot.header.cwd;
		} catch {
			// Unknown or raced-away session: treat as no known cwd.
		}
	}
	return void 0;
}

/**
 * Parse and validate the request body.
 * @param request - the incoming Fetch request.
 * @returns the sessionId, or an error object for the caller to return.
 */
async function readDeleteRequest(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return { error: { ok: false, status: 400, message: "body is not JSON" } };
	}
	const sessionId = body?.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		return { error: { ok: false, status: 400, message: "sessionId must be a non-empty string" } };
	}
	if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("\u0000")) {
		return { error: { ok: false, status: 400, message: "sessionId must be a single path-safe segment" } };
	}
	return { sessionId };
}

/**
 * Host plugin body: register the deletion route, wired to the context's
 * Workspace registry and session persistence when present.
 * @param ctx - Host context.
 */
export function apply(ctx) {
	// Track which sessions are ACTIVELY running (the agent loop is executing a
	// turn). Presence in `ctx.sessions` is deliberately NOT a reason to refuse:
	// sessions stay mounted after the user stops using them, so refusing by
	// liveness alone blocked every idle session. Only a session whose work is
	// actually executing right now is refused, because deleting its log while
	// the writer appends would corrupt it.
	const runningSessions = new Set();
	ctx.effect(() => {
		const offStatus = ctx.on("agent/status", (payload) => {
			const agent = payload && payload.agent;
			if (agent === void 0 || typeof agent.id !== "string") return;
			if (payload.status === "running") runningSessions.add(agent.id);
			else runningSessions.delete(agent.id);
		});
		const offDisposed = ctx.on("agent/disposed", (payload) => {
			const agent = payload && payload.agent;
			if (agent !== void 0 && typeof agent.id === "string") runningSessions.delete(agent.id);
		});
		return () => {
			offStatus();
			offDisposed();
			runningSessions.clear();
		};
	}, "session-delete: running-session tracking");

	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.effect(() => connectionCtx.connection.fetch.register({
			path: ENDPOINT_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const parsed = await readDeleteRequest(request);
				if (parsed.error !== void 0) {
					return Response.json({ ok: false, error: { message: parsed.error.message } }, { status: parsed.error.status });
				}
				const sessionId = parsed.sessionId;
				// Only a session with an agent actively executing a turn is
				// refused; idle sessions (even ones the host still has mounted)
				// are deletable.
				if (runningSessions.has(sessionId)) {
					return Response.json({
						ok: false,
						error: {
							code: "session/running",
							message: "该会话正在运行中（智能体正在执行任务），请等待其结束后再删除。"
						}
					}, { status: 409 });
				}
				const cwd = await resolveSessionCwd(connectionCtx, sessionId);
				try {
					// Accounting first so the UI never re-shows a deleted session.
					await removeWorkspaceReferences(connectionCtx, sessionId);
					const removed = await removeSessionArtifacts(sessionId, cwd);
					// The Client's session list is an event projection maintained by
					// `api-session/added` / `api-session/removed`. Removing the durable
					// artifacts alone leaves the id in the UI's list projection until
					// restart, so publish the removal through the official relay.
					connectionCtx.emit("api-session/removed", sessionId);
					return Response.json({
						ok: true,
						sessionId,
						removed
					});
				} catch (error) {
					return Response.json({
						ok: false,
						error: { message: error instanceof Error ? error.message : String(error) }
					}, { status: 500 });
				}
			}
		}), `session-delete: ${ENDPOINT_PATH}`);
	});
}
