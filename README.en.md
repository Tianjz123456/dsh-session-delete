# dsh-session-delete

> Adds a "Delete session" action to DeepSeek Harness (DSH): from one place in the
> session menu you can **fully delete** a session — its log directory, projection
> cache, and every reference held by workspaces.

`dsh-session-delete` is a DSH Cordis plugin that adds a **Delete session** entry to
the "⋯" menu of each session in the sidebar workspace browser. After a confirmation
step the deletion permanently removes all local traces of that session, rather than
hiding it or silently moving it into the "Ungrouped" bucket.

## Features

- **One-shot deletion from the UI**: a "Delete session" entry is added to the
  session menu, rendered with the framework menu-item component so its icon and
  typography align with the built-in rows (pin / rename / fork / archive).
- **Complete removal, no leftovers**:
  - deletes the session JSONL log directory
    (`~/.dsh/sessions/<project-key>/<session-id>/`);
  - deletes the projection-cache record
    (`~/.dsh/storages/session_projcache/sessions/<session-id>.json`);
  - drops the session from every workspace accounting slot (detach, unpin,
    unarchive).
- **The UI updates instantly**: after deletion the official `api-session/removed`
  event is emitted, so the session disappears from the list without a restart.
- **Guarded for in-use sessions (two layers)**: the session currently open in the
  sidebar (retained by the GUI, `retainedBy.mainView`) is refused straight in the
  client with a clear message; the host additionally refuses with a 409 only while
  an Agent is **actually executing a turn** (`agent/status === running`). Idle
  sessions — even ones the host still has mounted — can be deleted at any time.
- **Idempotent and safe**: missing targets are skipped silently; `sessionId` is
  validated as a single safe path segment (rejects `/`, `\`, NUL), preventing path
  traversal. Orphaned rows whose log directory is already gone (e.g. a
  projection-cache-only record) follow the backend's `_no-cwd` convention instead
  of erroring.
- **Reuses existing auth**: the route is registered on the shared `/api` channel and
  rides the same Host/Origin + browser authentication as every other API request.

## How it works

The session list in the DSH client is an **event projection**
(`api-session/added` / `api-session/removed`), not a live scan of the disk. Deleting
files alone would leave the session visible until restart. This plugin therefore
performs removal in three coordinated steps on the host side:

1. **Accounting**: find every workspace that contains the session and
   `detachSession`, then idempotently `unpinSession` / `unarchiveSession`;
2. **Disk**: remove the JSONL log directory and the projection-cache file
   (orphaned rows without a known `cwd` follow the backend's `_no-cwd`
   convention);
3. **Notify**: `emit("api-session/removed", sessionId)` drives the client projection
   update so the session is removed from the UI immediately.

> Guards: the client refuses the session currently open in the GUI; the host
> tracks sessions whose Agent is **actively executing** through `agent/status`
> events and refuses those with a 409. Idle sessions are never blocked.

The deletion capability is exposed by an authenticated host route
`POST /api/session-delete` (body `{ sessionId }`), which the client menu item calls
through the browser's native `fetch`.

## Requirements

| Dependency | Notes |
| --- | --- |
| DeepSeek Harness | a build supporting client dynamic module loading (`window.__ModuleLoader__`) and `ctx.connection.fetch.register` route extension |
| Runtime | Node.js (the host half uses only built-in modules such as `node:fs/promises`; no third-party runtime dependencies) |

## Installation

> The recommended path is DSH's bundle installation (`plugin_manager` →
> `install_bundle`), which handles dependency placement, patch merging, and
> enabling. The manual steps below are a fallback when that entry point is not
> available.

### Option 1: bundle install (recommended)

1. Place this directory (or the unpacked release archive) in your workspace, e.g.
   `<your-workspace>/dsh-session-delete`.
2. In Harness open the plugin manager, choose **Install bundle**, and point it at
   this directory.
3. After installation, confirm the `session-delete` entry is enabled in the plugin
   list.

The plugin is active immediately: open the "⋯" menu of any session and **Delete
session** appears at the bottom.

### Option 2: manual placement

1. Copy the package into the profile's `node_modules/@local/dsh-session-delete`:
   ```text
   <profile>/node_modules/@local/dsh-session-delete/
   ```
2. Make sure the profile's `cordis.patch.yml` (or an equivalent patch aggregate)
   includes:
   ```yaml
   - insert:
       - id: session-delete
         name: '@local/dsh-session-delete'
   ```
3. Restart (or hot-reload) Harness.

> Note: the package is both source and install payload (`index.js` / `client.js` are
> the runtime files). Host-side changes require a restart; client-side changes are
> picked up by HMR.

## Usage

1. Find the session in the **Workspaces** area of the sidebar.
2. Click the **"⋯"** menu at the end of the session row.
3. Choose **Delete session**.
4. Review the session in the confirmation dialog and confirm.

> ⚠️ **Irreversible**: this permanently deletes the session log and projection cache
> and removes its workspace references. There is no backup; double-check before
> deleting.

### Behaviour

| Action | Result |
| --- | --- |
| Menu rendering | The session menu gains a "Delete session" entry at the end |
| Click delete | A confirmation dialog warns the operation cannot be undone |
| After confirming | Workspace references are dropped → log and projection cache are deleted → the list refreshes instantly |

## Layout

```text
dsh-session-delete/
├── index.js           # Host side: registers POST /api/session-delete and the removal logic
├── client.js          # Client side: menu-item component (framework rendering, confirm, fetch)
├── cordis.patch.yml   # Loader patch: inserts the session-delete entry
├── package.json       # Manifest: exports, files, dsh.client inject declaration
├── LICENSE            # MIT license
├── locale/
│   ├── zh.json        # Chinese copy (mirrored inline in client.js)
│   └── en.json        # English copy
└── icon.svg           # Plugin display icon
```

## Data and paths

Paths involved in deletion (they follow `$DSH_HOME`, defaulting to `~/.dsh`):

| Content | Path |
| --- | --- |
| Session log directory | `$DSH_HOME/sessions/<project-key>/<session-id>/` |
| Projection cache | `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` |
| Workspace references | accounted by `workspaceRegistry` (`workspace.json` and friends) |

- `project-key` is derived from the session's project directory (header `cwd`);
- path segments are `~XXXX`-escaped for any string, which keeps them portable and
  free of path-traversal risk.

## Development & debugging

- **Host logic**: `index.js` has no third-party dependencies (Node built-ins only),
  easy to review in isolation or unit-test.
- **Client**: `client.js` probes
  `@deepseek-ai/dsh-client-ui-primitives` at runtime and, when available, reuses the
  framework menu-item component and icon (`MenuItemButton` / `IconTrashOutline16`).
  All accesses use strict `typeof === "function"` checks, and any resolution failure
  falls back safely — it never disables the entry.
- **Slot verification**: after install, use Cordis Inspect `Slots.listSubTree` on
  `sidebar.workspaces.session.menu.item` to observe the `active` state of the
  `session-delete` entry.

## Contributing

Issues and pull requests are welcome. Please keep:

- the host half free of third-party dependencies;
- copy in sync between `locale/*.json` and the inline dictionaries in `client.js`;
- the deletion flow idempotent and path-safe.

## License

[MIT](LICENSE) © 2026 dsh-session-delete contributors
