import type { ModelInfo } from "../types";
import { isCompleteModelReference } from "./rlm-preferences";

export const MAX_FAVORITE_MODELS = 64;

export function modelReference(model: Pick<ModelInfo, "provider" | "id">) {
  return `${model.provider}/${model.id}`;
}

export function normalizeFavoriteModelRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const ref = typeof entry === "string" ? entry.trim() : "";
    if (!isCompleteModelReference(ref) || seen.has(ref)) continue;
    seen.add(ref);
    normalized.push(ref);
    if (normalized.length >= MAX_FAVORITE_MODELS) break;
  }
  return normalized;
}

export function toggleFavoriteModelRef(value: unknown, ref: string): string[] {
  const normalized = normalizeFavoriteModelRefs(value);
  if (!isCompleteModelReference(ref)) return normalized;
  return normalized.includes(ref)
    ? normalized.filter((entry) => entry !== ref)
    : normalizeFavoriteModelRefs([...normalized, ref]);
}

export function orderModelsWithFavorites(models: ModelInfo[], favorites: unknown): ModelInfo[] {
  const favoriteOrder = new Map(normalizeFavoriteModelRefs(favorites).map((ref, index) => [ref, index]));
  return [...models].sort((left, right) => {
    const leftRank = favoriteOrder.get(modelReference(left));
    const rightRank = favoriteOrder.get(modelReference(right));
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return left.provider.localeCompare(right.provider)
      || (left.name ?? left.id).localeCompare(right.name ?? right.id)
      || left.id.localeCompare(right.id);
  });
}

export function filterModels(models: ModelInfo[], query: string, favorites: unknown, limit = 100): ModelInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  return orderModelsWithFavorites(models, favorites)
    .filter((model) => !needle || `${model.provider} ${model.name ?? ""} ${model.id}`.toLocaleLowerCase().includes(needle))
    .slice(0, Math.max(0, limit));
}
