/**
 * A tab dragged out of its strip (useTabReorder) over a sidebar workspace row: that row is where
 * the tab goes when it is let go (TabStrip), and the sidebar marks it (Sidebar). The strip holds
 * the pointer, so the row never sees the drag and is found by the point instead.
 */
export interface TabWorkspaceDrop {
  machineId: string;
  workspaceId: string;
}

let current: TabWorkspaceDrop | null = null;
const listeners = new Set<() => void>();

export const tabWorkspaceDrop = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): TabWorkspaceDrop | null => current,
  set(next: TabWorkspaceDrop | null): void {
    if (next === current || (next && current && next.machineId === current.machineId && next.workspaceId === current.workspaceId)) return;
    current = next;
    for (const listener of listeners) listener();
  },
};

/** The sidebar workspace row of `machineId` under the point, if any. */
export function workspaceRowAt(x: number, y: number, machineId: string): string | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(".workspace-group[data-workspace][data-machine]");
  return row && row.dataset["machine"] === machineId ? row.dataset["workspace"] ?? null : null;
}
