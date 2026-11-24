import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentSettings } from "./client/agent-settings";
import { ExcalidrawPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "agents", title: "Agent tools", icon: "Settings", Component: AgentSettings });
  client.addWorkspacePanel({
    id: "diagrams",
    title: "Excalidraw",
    icon: "PenTool",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ExcalidrawPanel,
  });
  client.addCommandCenterItem({
    id: "open-diagrams",
    title: "Open Excalidraw diagrams",
    icon: "PenTool",
    keywords: ["excalidraw", "diagram", "whiteboard", "draw"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("diagrams");
    },
  });
  return () => {};
}
