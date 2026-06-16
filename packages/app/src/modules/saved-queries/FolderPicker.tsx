/**
 * Reusable folder-tree picker used in both "Move to folder…" and "Save As" flows.
 * Renders a flat list of all folders (depth-indented) plus a "(root)" entry.
 */
import { Folder } from "lucide-react";
import type { SavedQueryFolder } from "./types";
import styles from "./SavedQueriesPanel.module.css";

interface FolderItem {
  id: string | null; // null = root
  name: string;
  depth: number;
}

function buildFolderItems(folders: SavedQueryFolder[]): FolderItem[] {
  const items: FolderItem[] = [{ id: null, name: "(root)", depth: 0 }];

  // Depth-first traversal to build ordered list with indentation.
  function visit(parentId: string | null, depth: number) {
    const children = folders
      .filter((f) => f.parent_id === parentId)
      .sort((a, b) => {
        const d = a.sort_order - b.sort_order;
        if (d !== 0) return d;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    for (const f of children) {
      items.push({ id: f.id, name: f.name, depth });
      visit(f.id, depth + 1);
    }
  }

  visit(null, 1);
  return items;
}

interface Props {
  folders: SavedQueryFolder[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function FolderPicker({ folders, selectedId, onSelect }: Props) {
  const items = buildFolderItems(folders);

  return (
    <div className={styles.folderPicker} role="listbox" aria-label="Select folder">
      {items.map((item) => (
        <button
          key={item.id ?? "__root__"}
          type="button"
          role="option"
          aria-selected={item.id === selectedId}
          data-selected={item.id === selectedId ? "true" : undefined}
          className={styles.folderPickerItem}
          style={{ paddingInlineStart: 8 + item.depth * 14 }}
          onClick={() => onSelect(item.id)}
        >
          <Folder size={13} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
          <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.name}
          </span>
        </button>
      ))}
      {items.length === 1 && (
        <div className={styles.empty}>No folders yet.</div>
      )}
    </div>
  );
}
