import type { Prisma, PrismaClient } from "../generated/client";
import crypto from "crypto";
import { hashTokenForStorage } from "../auth/tokenSecurity";
import { isTrashCollectionId } from "../routes/dashboard/trash";

export type DrawingPermission = "view" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export type DrawingPrincipal = { kind: "user"; userId: string };

// Custom fork: every newly created board is shared with all active users
// (except its creator) with edit access. Uses the same DrawingPermission rows
// as manual sharing, so they can be revoked or downgraded in the share dialog.
export const grantEditToAllActiveUsers = async (
  db: PrismaClient | Prisma.TransactionClient,
  drawingId: string,
  ownerUserId: string,
): Promise<void> => {
  const users = await db.user.findMany({
    where: { isActive: true, id: { not: ownerUserId } },
    select: { id: true },
  });
  if (users.length === 0) return;
  await db.drawingPermission.createMany({
    data: users.map((user) => ({
      drawingId,
      granteeUserId: user.id,
      permission: "edit",
      createdByUserId: ownerUserId,
    })),
  });
};

// Custom fork: shared folders. A collection share role can also be "owner"
// (co-owner: may rename the folder and manage its shares, but not delete it).
export type CollectionRole = "view" | "edit" | "owner";

export const normalizeCollectionRole = (
  input: unknown,
): CollectionRole | null => {
  if (input === "view" || input === "edit" || input === "owner") return input;
  return null;
};

// Effective role of a user in a collection: "owner" for the real owner,
// otherwise the role from CollectionShare, or null without access.
export const getCollectionRole = async (
  db: PrismaClient | Prisma.TransactionClient,
  collectionId: string,
  userId: string,
): Promise<CollectionRole | null> => {
  const collection = await db.collection.findUnique({
    where: { id: collectionId },
    select: { userId: true },
  });
  if (!collection) return null;
  if (collection.userId === userId) return "owner";
  const share = await db.collectionShare.findUnique({
    where: { collectionId_granteeUserId: { collectionId, granteeUserId: userId } },
    select: { role: true },
  });
  return normalizeCollectionRole(share?.role);
};

export const canFileIntoCollection = (role: CollectionRole | null): boolean =>
  role === "edit" || role === "owner";

// Custom fork: every newly created collection is shared with all active users
// (except its creator) with edit access, like new boards.
export const grantCollectionEditToAllActiveUsers = async (
  db: PrismaClient | Prisma.TransactionClient,
  collectionId: string,
  ownerUserId: string,
): Promise<void> => {
  const users = await db.user.findMany({
    where: { isActive: true, id: { not: ownerUserId } },
    select: { id: true },
  });
  if (users.length === 0) return;
  await db.collectionShare.createMany({
    data: users.map((user) => ({
      collectionId,
      granteeUserId: user.id,
      role: "edit",
      createdByUserId: ownerUserId,
    })),
  });
};

export const normalizeDrawingPermission = (
  input: unknown,
): DrawingPermission | null => {
  if (input === "view" || input === "edit") return input;
  return null;
};

export const buildShareLinkToken = (): string =>
  crypto.randomBytes(24).toString("base64url");

export const hashShareLinkToken = (token: string): string =>
  hashTokenForStorage(token);

export const getDrawingAccess = async (params: {
  prisma: PrismaClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  now?: Date;
}): Promise<DrawingAccess> => {
  const nowMs = (params.now ?? new Date()).getTime();

  let baseAccess: DrawingAccess = "none";

  // User-based access (owner or explicit ACL).
  if (params.principal?.kind === "user") {
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true, collectionId: true },
    });
    if (!drawing) return "none";
    if (drawing.userId === params.principal.userId) return "owner";

    const perm = await params.prisma.drawingPermission.findUnique({
      where: {
        drawingId_granteeUserId: {
          drawingId: params.drawingId,
          granteeUserId: params.principal.userId,
        },
      },
      select: { permission: true },
    });
    baseAccess = normalizeDrawingPermission(perm?.permission) ?? baseAccess;

    // A drawing inherits the strongest access available from its collection.
    // This matters when a direct drawing grant is weaker than the collection grant.
    // Custom fork: owning (or co-owning) the collection grants at most "edit".
    // Editors may file other people's drawings into their own folders, so
    // folder ownership must not escalate to drawing ownership.
    if (drawing.collectionId) {
      const role = await getCollectionRole(
        params.prisma,
        drawing.collectionId,
        params.principal.userId,
      );
      const collectionAccess: DrawingAccess =
        role === "owner" ? "edit" : (role ?? "none");
      baseAccess = maxAccess(baseAccess, collectionAccess);
    }
  }

  // Google Docs-style link policy: applies regardless of whether the visitor is signed in.
  // If a drawing has an active link-share policy, possession of the drawing id URL grants the policy access.
  const linkPolicy = await getActiveLinkShareAccess({
    prisma: params.prisma,
    drawingId: params.drawingId,
    nowMs,
  });
  const linkAccess: DrawingAccess = linkPolicy ?? "none";

  return maxAccess(baseAccess, linkAccess);
};

export const canViewDrawing = (
  access: DrawingAccess,
): access is Exclude<DrawingAccess, "none"> => access !== "none";

export const canEditDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "edit" | "owner"> =>
  access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean =>
  access === "owner";

const getActiveLinkShareAccess = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  nowMs: number;
}): Promise<DrawingPermission | null> => {
  const linkShare = await params.prisma.drawingLinkShare.findFirst({
    where: {
      drawingId: params.drawingId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(params.nowMs) } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      permission: true,
      drawing: { select: { userId: true, collectionId: true } },
    },
  });
  if (!linkShare) return null;
  // A drawing in its owner's Trash pauses the link share. The row is kept, so
  // restoring the drawing brings the same link back.
  if (
    isTrashCollectionId(
      linkShare.drawing.collectionId,
      linkShare.drawing.userId,
    )
  ) {
    return null;
  }
  return normalizeDrawingPermission(linkShare.permission);
};

const accessRank = (access: DrawingAccess): number => {
  switch (access) {
    case "owner":
      return 3;
    case "edit":
      return 2;
    case "view":
      return 1;
    default:
      return 0;
  }
};

const maxAccess = (a: DrawingAccess, b: DrawingAccess): DrawingAccess =>
  accessRank(a) >= accessRank(b) ? a : b;
