import { apiPath } from "./api";

export type PublicModelsConfig = {
  defaultModel: string;
  providers: Array<{
    id: string;
    name: string;
    models: string[];
  }>;
};

export type ConfiguredDefaultModel = {
  value: string;
  providerName: string;
  modelName: string;
};

export function configuredDefaultModelDetails(
  config: PublicModelsConfig
): ConfiguredDefaultModel | null {
  const selected = config.defaultModel.trim();
  if (!selected) return null;
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (`${provider.id}/${model}` === selected) {
        return {
          value: selected,
          providerName: provider.name.trim() || provider.id,
          modelName: model,
        };
      }
    }
  }
  return null;
}

/** Return the configured default only when it still belongs to a provider's
 * advertised model list. This matches the Chat-mode submit guard. */
export function configuredDefaultModel(config: PublicModelsConfig): string {
  return configuredDefaultModelDetails(config)?.value ?? "";
}

export function configuredDefaultModelLabel(config: PublicModelsConfig): string {
  const selected = configuredDefaultModelDetails(config);
  return selected ? `${selected.providerName}/${selected.modelName}` : "";
}

async function fetchModelsConfig(): Promise<PublicModelsConfig> {
  const response = await fetch(apiPath("/api/models"));
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return await response.json() as PublicModelsConfig;
}

export async function fetchConfiguredDefaultModel(): Promise<string> {
  return configuredDefaultModel(await fetchModelsConfig());
}

export async function fetchConfiguredDefaultModelLabel(): Promise<string> {
  return configuredDefaultModelLabel(await fetchModelsConfig());
}
