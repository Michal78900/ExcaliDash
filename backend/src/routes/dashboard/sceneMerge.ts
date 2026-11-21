// Custom fork: server-side element merge for editor autosaves.
//
// Several collaborators autosave the same drawing. With a strict version
// guard almost every save lost to a peer's save (409), and each client then
// had to download the whole scene, merge it and retry. Instead an autosave is
// merged into the stored scene inside the save transaction, the same way
// files are already union-merged (`mergeFilesUnion` in sceneUpdate.ts):
// a union by element id where the newer element wins. Deletions survive
// because Excalidraw deletes by writing an `isDeleted` tombstone with a
// higher version.

type SceneElement = Record<string, unknown> & { id?: unknown };

const getId = (element: unknown): string | null => {
  if (!element || typeof element !== "object") return null;
  const id = (element as SceneElement).id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const toNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Excalidraw's own rule: higher version wins; on equal versions the lower
// versionNonce wins. On a full tie the incoming element wins.
const pickNewer = (stored: SceneElement, incoming: SceneElement) => {
  const storedVersion = toNumber(stored.version);
  const incomingVersion = toNumber(incoming.version);
  if (storedVersion !== incomingVersion) {
    return storedVersion > incomingVersion ? stored : incoming;
  }
  const storedNonce = toNumber(stored.versionNonce);
  const incomingNonce = toNumber(incoming.versionNonce);
  if (storedNonce !== incomingNonce) {
    return storedNonce < incomingNonce ? stored : incoming;
  }
  return incoming;
};

export const mergeSceneElements = (
  storedElements: unknown,
  incomingElements: readonly unknown[],
): unknown[] => {
  const stored = Array.isArray(storedElements) ? storedElements : [];
  const incomingIds = new Set<string>();
  for (const element of incomingElements) {
    const id = getId(element);
    if (id) incomingIds.add(id);
  }

  const storedById = new Map<string, SceneElement>();
  // Stored-only elements keep their place: after the nearest preceding
  // element that the incoming scene also has (or at the head).
  const head: unknown[] = [];
  const after = new Map<string, unknown[]>();
  let anchor: string | null = null;
  for (const element of stored) {
    const id = getId(element);
    if (!id) continue;
    if (incomingIds.has(id)) {
      storedById.set(id, element as SceneElement);
      anchor = id;
      continue;
    }
    if (anchor === null) {
      head.push(element);
    } else {
      const list = after.get(anchor) ?? [];
      list.push(element);
      after.set(anchor, list);
    }
  }

  const merged: unknown[] = [...head];
  for (const element of incomingElements) {
    const id = getId(element);
    const previous = id ? storedById.get(id) : undefined;
    merged.push(
      previous ? pickNewer(previous, element as SceneElement) : element,
    );
    if (id) merged.push(...(after.get(id) ?? []));
  }

  // Excalidraw 0.18 orders elements by their fractional `index`; when every
  // element carries one, sort by it so interleaved additions land correctly.
  const allIndexed = merged.every(
    (element) =>
      typeof (element as SceneElement | null)?.index === "string" &&
      ((element as SceneElement).index as string).length > 0,
  );
  if (allIndexed) {
    return merged
      .map((element, position) => ({ element, position }))
      .sort((a, b) => {
        const ai = (a.element as SceneElement).index as string;
        const bi = (b.element as SceneElement).index as string;
        if (ai < bi) return -1;
        if (ai > bi) return 1;
        return a.position - b.position;
      })
      .map(({ element }) => element);
  }
  return merged;
};
