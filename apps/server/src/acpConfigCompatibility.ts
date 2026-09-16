import type { AnyMessage, NewSessionResponse, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";

type LegacyModels = {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string }[];
};

/** Older native agents (including Gemini) still expose models/modes separately.
 * Normalize before the SDK validates the response and drops the legacy fields. */
export class AcpConfigCompatibility {
  options: SessionConfigOption[] = [];
  private nativeOptions: SessionConfigOption[] = [];
  private models?: LegacyModels | null;
  private modes?: SessionModeState | null;
  private legacy = new Map<string, "model" | "mode">();

  normalize(message: AnyMessage): AnyMessage {
    if ("result" in message && message.result && typeof message.result === "object") {
      const response = message.result as NewSessionResponse & { models?: LegacyModels | null };
      if (typeof response.sessionId === "string") {
        this.models = response.models;
        this.modes = response.modes;
        this.replaceOptions(response.configOptions ?? []);
        return { ...message, result: { ...response, configOptions: this.options } };
      }
    }
    if ("method" in message && message.method === "session/update") {
      const params = message.params as { sessionId: string; update: Record<string, unknown> } | undefined;
      const update = params?.update;
      if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
        this.replaceOptions(update.configOptions);
      } else if (update?.sessionUpdate === "current_model_update" && typeof update.modelId === "string") {
        this.setCurrent("model", update.modelId);
      } else if (update?.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
        this.setCurrent("mode", update.currentModeId);
      } else {
        return message;
      }
      return { ...message, params: { ...params, update: {
        sessionUpdate: "config_option_update", configOptions: this.options,
      } } };
    }
    return message;
  }

  legacyKind(id: string): "model" | "mode" | undefined {
    return this.legacy.get(id);
  }

  replaceOptions(options: SessionConfigOption[]): void {
    this.nativeOptions = options;
    this.options = [...options];
    this.legacy.clear();
    const add = (kind: "model" | "mode", option: SessionConfigOption) => {
      if (options.some((entry) => entry.category === kind || entry.id === kind)) return;
      this.options.push(option);
      this.legacy.set(option.id, kind);
    };
    if (this.models?.availableModels?.length) {
      add("model", {
        id: "model", name: "Model", category: "model", type: "select",
        currentValue: this.models.currentModelId,
        options: this.models.availableModels.map((model) => ({
          value: model.modelId, name: model.name, description: model.description,
        })),
      });
    }
    if (this.modes?.availableModes?.length) {
      add("mode", {
        id: "mode", name: "Mode", category: "mode", type: "select",
        currentValue: this.modes.currentModeId,
        options: this.modes.availableModes.map((mode) => ({
          value: mode.id, name: mode.name, description: mode.description,
        })),
      });
    }
  }

  setCurrent(kind: "model" | "mode", value: string): void {
    if (kind === "model" && this.models) this.models.currentModelId = value;
    if (kind === "mode" && this.modes) this.modes.currentModeId = value;
    this.replaceOptions(this.nativeOptions.map((option) =>
      option.type === "select" && (option.category === kind || option.id === kind)
        ? { ...option, currentValue: value } : option
    ));
  }
}
