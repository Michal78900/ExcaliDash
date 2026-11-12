import type { Collection, DrawingSummary } from "../types";

// Custom fork: shared folders. A collection is writable (drawings can be
// created in / filed into it) for its owner and for users shared with the
// "edit" or "owner" (co-owner) role.
export const canWriteCollection = (collection?: Collection | null): boolean =>
  !!collection &&
  (collection.isOwner !== false ||
    collection.sharedRole === "edit" ||
    collection.sharedRole === "owner");

// Owner or co-owner: may rename the collection and manage its shares.
export const canManageCollection = (collection?: Collection | null): boolean =>
  !!collection &&
  (collection.isOwner !== false || collection.sharedRole === "owner");

// Anyone who can edit a drawing may move it between collections they can
// write to; drawings outside shared views are the user's own.
export const canMoveDrawing = (
  drawing: Pick<DrawingSummary, "accessLevel">,
  isShared: boolean,
): boolean =>
  !isShared ||
  drawing.accessLevel === "edit" ||
  drawing.accessLevel === "owner";

// Trash is per drawing owner, so only the owner may move a drawing there.
export const getMoveTargetCollections = (
  collections: Collection[],
  drawing: Pick<DrawingSummary, "accessLevel">,
  isShared: boolean,
): Collection[] => {
  const canTrash = !isShared || drawing.accessLevel === "owner";
  return collections.filter(
    (collection) =>
      canWriteCollection(collection) && (canTrash || collection.id !== "trash"),
  );
};
