import { useMemo, useRef, useState } from "react";
import { Brain, Check, Image, Info, LoaderCircle, Search, Star } from "lucide-react";
import { useI18n } from "../i18n";
import { filterModels, modelReference, normalizeFavoriteModelRefs } from "../lib/model-favorites";
import type { ModelInfo } from "../types";

interface ModelPickerPopoverProps {
  models: ModelInfo[];
  active?: string;
  favorites: string[];
  onChoose: (model: ModelInfo) => void | Promise<void>;
  onToggleFavorite: (ref: string) => void;
  align?: "left" | "right";
  emptyChoice?: { label: string; onChoose: () => void | Promise<void> };
  loadingWhenEmpty?: boolean;
}

export function ModelPickerPopover({
  models,
  active,
  favorites,
  onChoose,
  onToggleFavorite,
  align = "left",
  emptyChoice,
  loadingWhenEmpty = true,
}: ModelPickerPopoverProps) {
  const { language, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [pendingChoice, setPendingChoice] = useState<string>();
  const [choiceError, setChoiceError] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const favoriteSet = useMemo(() => new Set(normalizeFavoriteModelRefs(favorites)), [favorites]);
  const filtered = useMemo(() => filterModels(models, query, favorites), [favorites, models, query]);
  const favoriteEntries = filtered.filter((model) => favoriteSet.has(modelReference(model)));
  const providerGroups = new Map<string, ModelInfo[]>();
  for (const model of filtered) {
    if (favoriteSet.has(modelReference(model))) continue;
    providerGroups.set(model.provider, [...(providerGroups.get(model.provider) ?? []), model]);
  }
  const noMatches = models.length > 0 && filtered.length === 0;

  const runChoice = async (key: string, action: () => void | Promise<void>) => {
    if (pendingChoice) return;
    const trigger = rootRef.current
      ?.closest("[data-dismissable-layer]")
      ?.querySelector<HTMLElement>('[aria-expanded="true"]');
    setPendingChoice(key);
    setChoiceError(undefined);
    try {
      await action();
      requestAnimationFrame(() => trigger?.focus());
    } catch (error) {
      setChoiceError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingChoice(undefined);
    }
  };

  const renderModel = (model: ModelInfo, favoriteSection = false) => {
    const ref = modelReference(model);
    const favorite = favoriteSet.has(ref);
    return (
      <div className="model-row" key={ref}>
        <button type="button" className={`model-choice ${ref === active ? "is-selected" : ""}`} aria-pressed={ref === active} disabled={Boolean(pendingChoice)} onClick={() => void runChoice(ref, () => onChoose(model))}>
          <span><strong>{model.name ?? model.id}</strong><small>{favoriteSection ? `${model.provider} · ` : ""}{model.id}{model.contextWindow ? ` · ${compactModelNumber(model.contextWindow, locale)} ctx` : ""}</small></span>
          <span className="model-badges">{model.input?.includes("image") ? <Image size={13} /> : null}{model.reasoning ? <Brain size={13} /> : null}{pendingChoice === ref ? <LoaderCircle size={14} className="spin" /> : ref === active ? <Check size={15} /> : null}</span>
        </button>
        <button
          type="button"
          className={`model-favorite ${favorite ? "is-active" : ""}`}
          aria-label={favorite
            ? bi(language, `Retirer ${model.name ?? model.id} des favoris`, `Remove ${model.name ?? model.id} from favorites`)
            : bi(language, `Ajouter ${model.name ?? model.id} aux favoris`, `Add ${model.name ?? model.id} to favorites`)}
          aria-pressed={favorite}
          disabled={Boolean(pendingChoice)}
          onClick={() => onToggleFavorite(ref)}
        >
          <Star size={14} fill={favorite ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  return (
    <div ref={rootRef} className={`popover model-popover align-${align}`} role="dialog" aria-label={bi(language, "Sélectionner un modèle", "Select a model")} aria-busy={Boolean(pendingChoice)}>
      <div className="model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={bi(language, "Rechercher un modèle", "Search models")} aria-label={bi(language, "Rechercher un modèle", "Search models")} autoFocus /></div>
      <div className="model-list">
        {emptyChoice && !query.trim() ? <button type="button" className={`model-empty-choice ${!active ? "is-selected" : ""}`} aria-pressed={!active} disabled={Boolean(pendingChoice)} onClick={() => void runChoice("__empty__", emptyChoice.onChoose)}><span>{emptyChoice.label}</span>{pendingChoice === "__empty__" ? <LoaderCircle size={14} className="spin" /> : !active ? <Check size={15} /> : null}</button> : null}
        {models.length === 0 ? <div className="popover-empty">{loadingWhenEmpty ? <LoaderCircle size={18} className="spin" /> : null}{bi(language, loadingWhenEmpty ? "Chargement des modèles…" : "Aucun modèle disponible" , loadingWhenEmpty ? "Loading models…" : "No models available")}</div> : null}
        {noMatches ? <div className="popover-empty"><Search size={17} />{bi(language, "Aucun modèle correspondant", "No matching model")}</div> : null}
        {favoriteEntries.length ? <section aria-label={bi(language, "Modèles favoris", "Favorite models")}><div className="provider-heading is-favorites"><span className="provider-logo"><Star size={11} fill="currentColor" /></span>{bi(language, "Favoris", "Favorites")}</div>{favoriteEntries.map((model) => renderModel(model, true))}</section> : null}
        {Array.from(providerGroups.entries()).map(([provider, entries]) => <section key={provider} aria-label={provider}><div className="provider-heading"><span className="provider-logo">{provider.slice(0, 2).toUpperCase()}</span>{provider}</div>{entries.map((model) => renderModel(model))}</section>)}
      </div>
      {choiceError ? <p className="model-picker-error" role="alert"><Info size={13} />{choiceError}</p> : null}
      <footer><Info size={13} />{bi(language, "Les favoris sont enregistrés dans Prime Orbit.", "Favorites are saved in Prime Orbit.")}</footer>
    </div>
  );
}

function compactModelNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function bi(language: "fr" | "en", fr: string, en: string) {
  return language === "fr" ? fr : en;
}
