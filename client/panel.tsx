import { useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { withDiagramExtension } from "../shared/formats";
import { createFileRpc, listFilesRpc } from "../shared/rpc";
import { diagramSettings } from "../shared/settings";
import { DiagramView } from "./diagram-view";
import { isWeb } from "./web";

export function ExcalidrawPanel(props: PluginWorkspacePanelProps) {
  // Native never reaches Excalidraw: this branch returns before any web-only module is used.
  if (!isWeb) return <NativeNotice {...props} />;
  return <WebPanel {...props} />;
}

function NativeNotice({ theme, layout }: PluginWorkspacePanelProps) {
  return (
    <View style={{ flex: 1, padding: layout.compact ? 16 : 24, gap: 8, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 18 }}>Excalidraw is desktop and web only</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Open this workspace in the Paseo desktop app or in a browser to view and edit diagrams. Agents can still edit them
        from here.
      </Text>
    </View>
  );
}

function normalizeName(input: string): string {
  const trimmed = input.trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  return withDiagramExtension(trimmed);
}

function WebPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const settings = useSettings(diagramSettings);
  const listFiles = useRpc(listFilesRpc);
  const createFile = useRpc(createFileRpc);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const restored = useRef(false);

  const styles = useMemo(
    () => ({
      root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      title: { color: theme.colors.foreground, flexShrink: 1 },
      muted: { color: theme.colors.foregroundMuted },
      button: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      primary: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.accent },
      row: { paddingHorizontal: layout.compact ? 12 : 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      input: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
    }),
    [theme, layout.compact],
  );

  const files = useQuery({
    queryKey: ["excalidraw", "files", workspaceId],
    queryFn: () => listFiles({ workspaceId }),
    refetchInterval: 5000,
  });

  // Reopen the last diagram of this workspace once settings have loaded.
  useEffect(() => {
    if (restored.current || settings.status !== "ready") return;
    restored.current = true;
    const last = settings.values.lastFile[workspaceId];
    if (last) setSelected(last);
  }, [settings, workspaceId]);

  function choose(path: string | null) {
    setSelected(path);
    if (path && settings.status === "ready") {
      void settings.save({ ...settings.values, lastFile: { ...settings.values.lastFile, [workspaceId]: path } }, settings.revision);
    }
  }

  const create = useMutation({
    mutationFn: (path: string) => createFile({ workspaceId, path }),
    onSuccess: async ({ path }) => {
      setNewName("");
      await queryClient.invalidateQueries({ queryKey: ["excalidraw", "files", workspaceId] });
      choose(path);
    },
  });

  if (selected) {
    return (
      <View style={styles.root}>
        <View style={styles.bar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to diagram list" onPress={() => choose(null)} style={styles.button}>
            <Text style={styles.title}>‹ Diagrams</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {selected}
          </Text>
        </View>
        <DiagramView key={`${workspaceId}:${selected}`} workspaceId={workspaceId} path={selected} theme={theme} />
      </View>
    );
  }

  const name = normalizeName(newName);
  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="New diagram, e.g. docs/architecture (or name.excalidraw.svg)"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          onSubmitEditing={() => name && create.mutate(name)}
          accessibilityLabel="New diagram name"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create diagram"
          disabled={!name || create.isPending}
          onPress={() => create.mutate(name)}
          style={[styles.primary, !name ? { opacity: 0.5 } : null]}
        >
          <Text style={{ color: theme.colors.accentForeground }}>New diagram</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh list" onPress={() => void files.refetch()} style={styles.button}>
          <Text style={styles.title}>Refresh</Text>
        </Pressable>
      </View>
      {create.error ? (
        <Text style={{ color: theme.colors.statusDanger, padding: 12 }}>{create.error instanceof Error ? create.error.message : String(create.error)}</Text>
      ) : null}
      {files.error ? (
        <Text style={{ color: theme.colors.statusDanger, padding: 12 }}>{files.error instanceof Error ? files.error.message : String(files.error)}</Text>
      ) : null}
      <ScrollView style={{ flex: 1 }}>
        {files.data?.files.map((file) => (
          <Pressable key={file.path} accessibilityRole="button" onPress={() => choose(file.path)} style={styles.row}>
            <Text style={styles.title}>{file.path}</Text>
            <Text style={styles.muted}>{new Date(file.mtimeMs).toLocaleString()}</Text>
          </Pressable>
        ))}
        {files.data && files.data.files.length === 0 ? (
          <Text style={[styles.muted, { padding: 16 }]}>No .excalidraw, .excalidraw.svg or .excalidraw.png files in this workspace yet. Create one above, or ask an agent to.</Text>
        ) : null}
        {files.data?.truncated ? <Text style={[styles.muted, { padding: 16 }]}>Showing the first 500 diagrams.</Text> : null}
        {files.isLoading ? <Text style={[styles.muted, { padding: 16 }]}>Loading…</Text> : null}
      </ScrollView>
    </View>
  );
}
