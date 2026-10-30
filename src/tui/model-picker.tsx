/** Seletor de modelos da TUI (#227): busca, favoritos, recentes e detalhe. */
import { Box, Text, useInput } from "ink";
import { useState, type ReactElement } from "react";
import { filterModels, modelDetail, orderModels, toggleFavorite, type ModelOption } from "./models";
import type { ThemeColors } from "./theme";

export interface ModelPickerProps {
  models: readonly ModelOption[];
  favorites: readonly string[];
  recents: readonly string[];
  colors: ThemeColors;
  onClose: () => void;
  onExit?: () => void;
  onSelect: (ref: string) => void;
  onFavorite: (favorites: string[]) => void;
}

export function ModelPicker({
  models, favorites, recents, colors, onClose, onExit, onSelect, onFavorite,
}: ModelPickerProps): ReactElement {
  const [query, setQuery] = useState("");
  const [selectedRef, setSelectedRef] = useState<string | undefined>(undefined);
  const ordered = orderModels(filterModels(models, query), favorites, recents);
  const found = ordered.findIndex((model) => model.ref === selectedRef);
  const selected = found < 0 ? 0 : found;
  const current = ordered[Math.min(selected, Math.max(ordered.length - 1, 0))];

  const move = (delta: number): void => {
    if (ordered.length === 0) return;
    const next = (Math.max(selected, 0) + delta + ordered.length) % ordered.length;
    setSelectedRef(ordered[next]?.ref);
  };

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) {
      (onExit ?? onClose)();
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow || key.tab || input === "\t") {
      move(1);
      return;
    }
    if (key.return) {
      if (current !== undefined) onSelect(current.ref);
      return;
    }
    if (((key.ctrl && input === "f") || input === "\u0006") && current !== undefined) {
      setSelectedRef(current.ref);
      onFavorite(toggleFavorite(current.ref, favorites));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setSelectedRef(undefined);
      return;
    }
    if (!key.ctrl && !key.meta && input !== "") {
      setQuery((value) => value + input.replace(/[\r\n\t]/g, ""));
      setSelectedRef(undefined);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Modelos</Text>
      <Text>{query === "" ? "buscar: _" : `buscar: ${query}`}</Text>
      {ordered.length === 0 ? <Text dimColor>nenhum modelo</Text> : null}
      {ordered.map((model, index) => (
        <Text key={model.ref} color={index === selected ? colors.accent : undefined}>
          {index === selected ? "> " : "  "}
          {favorites.includes(model.ref) ? "* " : "  "}
          {model.ref} {model.status} contexto {model.context ?? "n/d"}
        </Text>
      ))}
      {current === undefined ? null : <Text dimColor>{modelDetail(current)}</Text>}
      <Text dimColor>↑↓/tab mover · enter trocar · ctrl+f favorito · esc voltar</Text>
    </Box>
  );
}
