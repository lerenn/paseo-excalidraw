import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { agentSettings } from "../shared/settings";

export function AgentSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(agentSettings);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foreground }}>Loading settings…</Text>;
  if (settings.status !== "ready") return (
    <SettingsSection title="Agent tools">
      <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
      <SettingsAction label="Read settings again" actionLabel="Reload" onPress={settings.reload} />
      {settings.status === "invalid" ? <SettingsAction label="Restore safe defaults" actionLabel="Reset" onPress={settings.reset} /> : null}
    </SettingsSection>
  );
  return (
    <SettingsSection title="Agent tools">
      <SettingsCard>
        <SettingsSwitch
          label="Enable Pi diagram tools"
          hint="Off by default. Enable only after verifying Pi MCP support on this host. An incompatible Pi runtime or a failed MCP probe can prevent new Pi agents from starting. Existing agents are unchanged."
          value={settings.values.enablePiMcp}
          disabled={settings.saving}
          error={settings.saveError}
          onValueChange={(enablePiMcp) => { void settings.save({ enablePiMcp }, settings.revision); }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
