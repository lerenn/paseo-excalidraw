import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  readFileRpc,
  runtimeChunkRpc,
  runtimeInfoRpc,
  statFileRpc,
  writeFileRpc,
} from "../shared/rpc";
import { diagramFormat } from "../shared/formats";
import { loadRuntimeHtml, mountDiagramFrame, type DiagramFrame } from "./web";

const POLL_MS = 1000;

type Status = { kind: "loading" } | { kind: "ready" } | { kind: "missing" } | { kind: "error"; message: string };

function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{6})/i.exec(color)?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255 < 0.5;
}

interface Props {
  workspaceId: string;
  path: string;
  theme: PluginTheme;
}

/**
 * One open diagram. The file on the daemon is the source of truth; this component:
 *  - saves the iframe's scene with the last-seen version (a stale write comes back as a conflict),
 *  - on conflict or an external change hands the newer file to the iframe, which merges it with
 *    Excalidraw's reconcileElements (element version / versionNonce) and re-emits if it differs,
 *  - polls a cheap stat RPC about once a second to notice edits by agents or other clients.
 */
export function DiagramView({ workspaceId, path, theme }: Props) {
  const hostRef = useRef<unknown>(null);
  const frameRef = useRef<DiagramFrame | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const dark = isDark(theme.colors.surface0);
  const darkRef = useRef(dark);
  darkRef.current = dark;

  const rpc = {
    read: useRpc(readFileRpc),
    stat: useRpc(statFileRpc),
    write: useRpc(writeFileRpc),
    info: useRpc(runtimeInfoRpc),
    chunk: useRpc(runtimeChunkRpc),
  };
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // base: the file version the iframe's scene is known to descend from.
    const state = { base: "", saving: false, pending: null as string | null, polling: false };
    const format = diagramFormat(path) ?? "json";
    setStatus({ kind: "loading" });
    setSaveError(null);

    const fail = (error: unknown) => {
      if (!disposed) setSaveError(error instanceof Error ? error.message : String(error));
    };

    async function flush() {
      if (state.saving) return;
      state.saving = true;
      try {
        while (state.pending !== null && !disposed) {
          const scene = state.pending;
          state.pending = null;
          const result = await rpcRef.current.write({ workspaceId, path, content: scene, baseVersion: state.base });
          state.base = result.version;
          if (result.status === "conflict") {
            // Someone else wrote first: merge their file into the iframe; it re-emits if it has more.
            frameRef.current?.send({ type: "remote", scene: result.content, format });
          }
          if (!disposed) setSaveError(null);
        }
      } catch (error) {
        fail(error);
      } finally {
        state.saving = false;
      }
    }

    async function poll() {
      if (state.polling || state.saving || state.pending !== null || disposed) return;
      state.polling = true;
      try {
        const stat = await rpcRef.current.stat({ workspaceId, path });
        if (disposed || state.saving || state.pending !== null) return;
        if (!stat.exists) {
          setStatus({ kind: "missing" });
        } else if (stat.version !== state.base) {
          const file = await rpcRef.current.read({ workspaceId, path });
          if (disposed || state.saving || state.pending !== null) return;
          state.base = file.version;
          frameRef.current?.send({ type: "remote", scene: file.content, format });
          setStatus({ kind: "ready" });
        }
      } catch (error) {
        fail(error);
      } finally {
        state.polling = false;
      }
    }

    (async () => {
      try {
        const [file, html] = await Promise.all([
          rpcRef.current.read({ workspaceId, path }),
          loadRuntimeHtml({
            info: () => rpcRef.current.info({}),
            chunk: async (hash, index) => (await rpcRef.current.chunk({ hash, index })).base64,
          }),
        ]);
        if (disposed || !hostRef.current) return;
        state.base = file.version;
        frameRef.current = mountDiagramFrame(hostRef.current, html, (message) => {
          switch (message.type) {
            case "ready":
              frameRef.current?.send({ type: "load", scene: file.content, format, theme: darkRef.current ? "dark" : "light" });
              setStatus({ kind: "ready" });
              break;
            case "changed":
              state.pending = message.scene;
              void flush();
              break;
            case "error":
              fail(new Error(message.message));
              break;
          }
        });
        timer = setInterval(() => void poll(), POLL_MS);
      } catch (error) {
        if (!disposed) setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      frameRef.current?.destroy();
      frameRef.current = null;
    };
  }, [workspaceId, path]);

  useEffect(() => {
    frameRef.current?.send({ type: "theme", theme: dark ? "dark" : "light" });
  }, [dark]);

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {status.kind === "error" || status.kind === "missing" || saveError ? (
        <Text style={{ color: theme.colors.statusDanger, paddingHorizontal: 12, paddingVertical: 4 }}>
          {status.kind === "missing"
            ? `${path} no longer exists.`
            : status.kind === "error"
              ? status.message
              : `Could not save: ${saveError}`}
        </Text>
      ) : null}
      {status.kind === "loading" ? (
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 4 }}>Loading diagram…</Text>
      ) : null}
      <View ref={hostRef as never} style={{ flex: 1, minHeight: 0 }} />
    </View>
  );
}
