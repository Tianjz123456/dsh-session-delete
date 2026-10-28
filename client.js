window.__ModuleLoader__.load({
  id: "@local/dsh-session-delete",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    // Framework-first rendering. The shipped session-menu rows render through
    // ui-primitives' `MenuItemButton`, so probing that export and reusing it
    // makes this row the SAME component → identical padding, icon slot,
    // font and hover styling with zero hand-tuned values. Strict typeof
    // checks only; anything unavailable falls back, never to a crash.
    let MenuItemButton = null;
    let IconTrashOutline16 = null;
    try {
      const prim = require("@deepseek-ai/dsh-client-ui-primitives");
      if (prim) {
        if (typeof prim.MenuItemButton === "function") MenuItemButton = prim.MenuItemButton;
        if (typeof prim.IconTrashOutline16 === "function") IconTrashOutline16 = prim.IconTrashOutline16;
      }
    } catch (err) {
      MenuItemButton = null;
      IconTrashOutline16 = null;
    }

    /** Locale namespace for this bundle's menu copy. */
    const LOCALE_NS = "session-delete";

    /** Display + action strings, mirrored in locale/zh.json and locale/en.json. */
    const DICTIONARIES = {
      zh: {
        "delete.label": "删除会话",
        "delete.confirmTitle": "删除会话",
        "delete.confirm": "确定要永久删除这个会话吗？",
        "delete.irreversible": "这将同时删除会话日志、投影缓存并从工作区中移除该会话。此操作不可恢复。",
        "delete.pending": "删除中…",
        "delete.error": "删除失败",
        "delete.currentRefusal": "当前会话正在使用中，无法删除。请先切换到其他会话。"
      },
      en: {
        "delete.label": "Delete session",
        "delete.confirmTitle": "Delete session",
        "delete.confirm": "Permanently delete this conversation?",
        "delete.irreversible": "This deletes the session log and projection cache and removes the session from its workspace. This cannot be undone.",
        "delete.pending": "Deleting…",
        "delete.error": "Delete failed",
        "delete.currentRefusal": "The current session is in use and cannot be deleted. Switch to another session first."
      }
    };

    /** Host route the menu action calls. */
    const ENDPOINT = "/api/session-delete";

    /**
     * Close the row "..." menu through the owner-injected `useMenuOpenState`
     * hook — the same contract every shipped row uses. The hook is a prop of
     * the occurrence, never a field under `props.hooks`; calling it returns the
     * `[open, setOpen]` pair. Unknown/absent shapes degrade to a no-op.
     */
    function useCloseMenu(useMenuOpenState) {
      const pair = typeof useMenuOpenState === "function" ? useMenuOpenState() : null;
      const setOpen = Array.isArray(pair) ? pair[1] : null;
      return typeof setOpen === "function" ? setOpen : function noopCloseMenu() {};
    }

    /**
     * Resolve the currently retained main conversation from the framework's
     * `useSessions` selector (the same data the built-in browser reads:
     * `byId[id].retainedBy.mainView > 0`). Deletion of that session is refused
     * client-side, because an in-use conversation is not necessarily "live" on
     * the host between turns (its Agent has quiesced) and deleting it would
     * destroy the log the user is still writing to.
     */
    function useCurrentMainSessionId(useSessions) {
      if (typeof useSessions !== "function") return undefined;
      try {
        return useSessions((snapshot) => {
          const byId = snapshot && snapshot.byId;
          if (!byId) return undefined;
          for (const id of Object.keys(byId)) {
            const row = byId[id];
            if (row && (row.retainedBy?.mainView ?? 0) > 0) return id;
          }
          return undefined;
        });
      } catch (err) {
        return undefined;
      }
    }

    /**
     * Resolve one display string from this bundle's own dictionaries by the
     * injected active language. The framework `t` seat is deliberately not
     * used: its key is shown verbatim when the namespace registration is
     * unavailable or collides, which surfaced as a raw "delete.label" label.
     */
    function textOf(lang, key) {
      const active = typeof lang === "string" ? lang.toLowerCase() : "";
      const dict = active.startsWith("en") ? DICTIONARIES.en : DICTIONARIES.zh;
      return dict[key] || key;
    }

    function DeleteSessionMenuItem(props) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const sessionId = props && props.sessionId;
      const displayTitle = (props && props.displayTitle) || "";
      const lang = (props && props.lang) || "zh";
      const text = (key) => textOf(lang, key);
      const closeMenu = useCloseMenu(props && props.useMenuOpenState);
      const currentMainId = useCurrentMainSessionId(props && props.useSessions);
      const isCurrentSession = typeof sessionId === "string" && currentMainId === sessionId;
      const label = text("delete.label");

      const onDelete = async () => {
        if (busy || typeof sessionId !== "string") return;
        // The session that is open in the GUI right now cannot be deleted,
        // even though its Agent may be idle on the host between turns.
        if (isCurrentSession) {
          setError(text("delete.currentRefusal"));
          return;
        }
        const name = displayTitle.trim() === "" ? sessionId : displayTitle;
        const message = [
          text("delete.confirmTitle"),
          "",
          text("delete.confirm") + "\n\u201C" + name + "\u201D",
          "",
          text("delete.irreversible")
        ].join("\n");
        if (typeof window !== "undefined" && !window.confirm(message)) return;

        setBusy(true);
        setError(null);
        try {
          const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId })
          });
          let payload = null;
          try {
            payload = await response.json();
          } catch (err) {
            // non-JSON error body
          }
          if (!response.ok || !payload || payload.ok !== true) {
            const msg = payload && payload.error && payload.error.message ? payload.error.message : "HTTP " + response.status;
            throw new Error(msg);
          }
          closeMenu();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      };

      // 1) True framework path: reuse the same row component the shipped items
      //    use → alignment, sizing, danger tint and hover all come from DSH.
      //    The icon slot MUST always receive an element (never null) or the
      //    row shows no icon: framework icon when resolvable, else an inline
      //    16px trash glyph that inherits the danger color.
      if (MenuItemButton !== null) {
        let icon;
        if (IconTrashOutline16 !== null) {
          icon = h(IconTrashOutline16, { "aria-hidden": true });
        } else {
          icon = h("svg", {
            viewBox: "0 0 16 16",
            width: 16,
            height: 16,
            fill: "currentColor",
            "aria-hidden": true
          }, h("path", {
            d: "M5 4V2.5A1.5 1.5 0 0 1 6.5 1h3A1.5 1.5 0 0 1 11 2.5V4h3v1.5h-.9l-.5 8A1.5 1.5 0 0 1 11.11 15H4.89a1.5 1.5 0 0 1-1.49-1.5l-.5-8H2V4h3zm1.5 0h3V2.5h-3V4zM4.42 5.5l.46 7.5h6.24l.46-7.5H4.42z"
          }));
        }
        return h(
          MenuItemButton,
          {
            danger: true,
            icon: icon,
            // MenuItemButton is a selection-driven row: the shipped rows (pin /
            // rename / fork / archive / session-id) all dispatch through
            // `onSelect`. `onClick` is not part of its contract — the previous
            // version passed `onClick` here, so clicking the row never fired.
            onSelect: onDelete,
            disabled: busy || typeof sessionId !== "string",
            role: "menuitem",
            "data-session-delete-item": true,
            "aria-disabled": busy || typeof sessionId !== "string"
          },
          h("span", null, label),
          busy || error !== null
            ? h("span", { style: { marginLeft: "auto", fontSize: 12, opacity: 0.7 } },
                error !== null ? error : text("delete.pending"))
            : null
        );
      }

      // 2) Framework icon, hand-rolled row (used when MenuItemButton is not a
      //    public export). Sizing matches the framework menu list: 13px/20px
      //    text, 16px icon flush-left, 6px vertical / 12px side insets.
      const ROW_STYLE = {
        display: "flex",
        width: "100%",
        boxSizing: "border-box",
        alignItems: "center",
        gap: 10,
        border: "none",
        background: "transparent",
        padding: "6px 12px",
        margin: 0,
        fontFamily: "inherit",
        fontSize: 13,
        lineHeight: "20px",
        fontWeight: 500,
        color: "var(--dsw-alias-danger-fg, #c9403f)",
        textAlign: "left",
        whiteSpace: "nowrap",
        cursor: "pointer"
      };

      let icon;
      if (IconTrashOutline16 !== null) {
        icon = h(IconTrashOutline16, { style: { flex: "none", display: "block" }, "aria-hidden": true });
      } else {
        icon = h("svg", {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          fill: "currentColor",
          style: { flex: "none", display: "block" },
          "aria-hidden": true
        }, h("path", {
          d: "M5 4V2.5A1.5 1.5 0 0 1 6.5 1h3A1.5 1.5 0 0 1 11 2.5V4h3v1.5h-.9l-.5 8A1.5 1.5 0 0 1 11.11 15H4.89a1.5 1.5 0 0 1-1.49-1.5l-.5-8H2V4h3zm1.5 0h3V2.5h-3V4zM4.42 5.5l.46 7.5h6.24l.46-7.5H4.42z"
        }));
      }

      const status =
        error !== null
          ? h("span", { role: "status", style: { flex: "none", marginLeft: 8, fontSize: 12, lineHeight: "16px", opacity: 0.7 } }, error)
          : busy
            ? h("span", { role: "status", style: { flex: "none", marginLeft: 8, fontSize: 12, lineHeight: "16px", opacity: 0.7 } }, text("delete.pending"))
            : null;

      return h(
        "button",
        {
          type: "button",
          role: "menuitem",
          style: ROW_STYLE,
          disabled: busy || typeof sessionId !== "string",
          onClick: onDelete,
          title: error === null ? undefined : error,
          "aria-disabled": busy || typeof sessionId !== "string",
          "data-session-delete-item": true
        },
        icon,
        h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" } }, label),
        status
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        try {
          ctx.locale.register(LOCALE_NS, DICTIONARIES);
        } catch (err) {
          // tolerate duplicate / transient locale collisions
        }

        ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
          return ctx.slots.register({
            name: "sidebar.workspaces.session.menu.item",
            id: "session-delete",
            order: 500,
            inject: function () {
              // Inject the active language id, NOT the framework `t` seat: the
              // component resolves copy from its own dictionaries, so a failed
              // or colliding namespace registration can never surface raw keys.
              let lang = "zh";
              try {
                const snapshot = ctx.locale.getSnapshot();
                if (snapshot && typeof snapshot.active === "string") lang = snapshot.active;
              } catch (err) {
                // locale service unavailable; the zh default dictionary applies.
              }
              return { lang: lang };
            }
          }, DeleteSessionMenuItem);
        });
      }
    };
  }
});
