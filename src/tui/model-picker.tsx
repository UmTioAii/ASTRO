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
  onSelect: (ref: string) => void;
  onFavorite: (favorites: string[]) => void;
}

export function ModelPicker({
  models, favorites, recents, colors, onClose, onSelect, onFavorite,
}: ModelPickerProps): ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const ordered = orderModels(filterModels(models, query), favorites, recents);
  const current = ordered[Math.min(selected, Math.max(ordered.length - 1, 0))];

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((value) => Math.min(ordered.length - 1, value + 1));
      return;
    }
    if (key.return) {
      if (current !== undefined) onSelect(current.ref);
      return;
    }
    if (input === "f" && current !== undefined) {
      onFavorite(toggleFavorite(current.ref, favorites));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && input !== "") {
      setQuery((value) => value + input.replace(/[\r\n]/g, ""));
      setSelected(0);
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
          {model.ref} {model.status} contexto {model.context}
        </Text>
      ))}
      {current === undefined ? null : <Text dimColor>{modelDetail(current)}</Text>}
      <Text dimColor>↑↓ mover · enter trocar · f favorito · esc voltar</Text>
    </Box>
  );
}
