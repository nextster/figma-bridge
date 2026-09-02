const UNDO_BOUNDARY_KEY = "figma-bridge-undo-boundary";

/**
 * Isolate a mutation from earlier actions made by this long-running plugin.
 * Figma ignores empty commitUndo() calls, so a private plugin-data marker is
 * used to create a real boundary without adding visible document nodes.
 */
export async function withUndoTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const previousMarker = figma.root.getPluginData(UNDO_BOUNDARY_KEY);
  const boundaryMarker = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  figma.root.setPluginData(UNDO_BOUNDARY_KEY, boundaryMarker);
  figma.commitUndo();
  try {
    const result = await operation();
    figma.root.setPluginData(UNDO_BOUNDARY_KEY, previousMarker);
    figma.commitUndo();
    return result;
  } catch (error) {
    figma.triggerUndo();
    throw error;
  }
}
