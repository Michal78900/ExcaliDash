import express from "express";
import { DashboardRouteDeps } from "./types";
import { getUserTrashCollectionId, isTrashCollectionId } from "./trash";
import {
  getCollectionRole,
  grantCollectionEditToAllActiveUsers,
  normalizeCollectionRole,
} from "../../authz/sharing";

export const registerCollectionRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    collectionNameSchema,
    sanitizeText,
    ensureTrashCollection,
    invalidateDrawingsCache,
    config,
    logAuditEvent,
    revalidateDrawingAccess,
    revalidateCollectionAccess,
  } = deps;

  const refreshLiveAccess = async (collectionId: string): Promise<void> => {
    try {
      await revalidateCollectionAccess?.(collectionId);
    } catch (error) {
      console.error("Failed to revalidate live collection access:", error);
    }
  };

  // Custom fork: the owner or a co-owner (share role "owner") may rename a
  // collection and manage its shares. Deleting stays owner-only.
  const findManageableCollection = async (id: string, userId: string) => {
    if (isTrashCollectionId(id, userId)) return null;
    const role = await getCollectionRole(prisma, id, userId);
    if (role !== "owner") return null;
    return prisma.collection.findUnique({ where: { id } });
  };

  // GET /collections — returns owned collections + collections shared with user
  app.get(
    "/collections",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const trashCollectionId = getUserTrashCollectionId(req.user.id);
      await ensureTrashCollection(prisma, req.user.id);

      const rawCollections = await prisma.collection.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: "desc" },
      });
      const hasInternalTrash = rawCollections.some(
        (c) => c.id === trashCollectionId,
      );
      const shares = await prisma.collectionShare.groupBy({
        by: ["collectionId"],
        where: { collection: { userId: req.user.id } },
      });
      const sharedIds = new Set(shares.map((share) => share.collectionId));
      const ownedCollections = rawCollections
        .filter((c) => !(hasInternalTrash && c.id === "trash"))
        .map((c) =>
          c.id === trashCollectionId
            ? {
                ...c,
                id: "trash",
                name: "Trash",
                sharedRole: null,
                isOwner: true,
                isShared: false,
              }
            : {
                ...c,
                sharedRole: null,
                isOwner: true,
                isShared: sharedIds.has(c.id),
              },
        );

      // Collections shared with this user by others
      const sharedEntries = await prisma.collectionShare.findMany({
        where: { granteeUserId: req.user.id },
        include: {
          collection: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });
      const sharedCollections = sharedEntries.map((s) => ({
        ...s.collection,
        sharedRole: s.role,
        isOwner: false,
      }));

      return res.json([...ownedCollections, ...sharedCollections]);
    }),
  );

  // POST /collections
  app.post(
    "/collections",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const parsed = collectionNameSchema.safeParse(req.body.name);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Collection name must be between 1 and 100 characters",
        });
      }

      const sanitizedName = sanitizeText(parsed.data, 100);
      const userId = req.user.id;
      const newCollection = await prisma.$transaction(async (tx) => {
        const created = await tx.collection.create({
          data: { name: sanitizedName, userId },
        });
        await grantCollectionEditToAllActiveUsers(tx, created.id, userId);
        return created;
      });
      invalidateDrawingsCache();
      return res.json({ ...newCollection, sharedRole: null, isOwner: true });
    }),
  );

  // PUT /collections/:id — owner only
  app.put(
    "/collections/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      if (isTrashCollectionId(id, req.user.id)) {
        return res.status(400).json({
          error: "Validation error",
          message: "Trash collection cannot be renamed",
        });
      }
      const existing = await findManageableCollection(id, req.user.id);
      if (!existing)
        return res.status(404).json({ error: "Collection not found" });

      const parsed = collectionNameSchema.safeParse(req.body.name);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation error",
          message: "Collection name must be between 1 and 100 characters",
        });
      }

      const sanitizedName = sanitizeText(parsed.data, 100);
      const updated = await prisma.collection.update({
        where: { id },
        data: { name: sanitizedName },
      });
      return res.json(updated);
    }),
  );

  // DELETE /collections/:id — owner only
  app.delete(
    "/collections/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const { id } = req.params;
      if (isTrashCollectionId(id, req.user.id)) {
        return res.status(400).json({
          error: "Validation error",
          message: "Trash collection cannot be deleted",
        });
      }
      const collection = await prisma.collection.findFirst({
        where: { id, userId: req.user.id },
      });
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      const drawings = revalidateDrawingAccess
        ? await prisma.drawing.findMany({
            where: { collectionId: id },
            select: { id: true },
          })
        : [];
      await prisma.$transaction([
        prisma.drawing.updateMany({
          // Custom fork: shared folders can hold other users' drawings too.
          where: { collectionId: id },
          data: { collectionId: null },
        }),
        prisma.collectionShare.deleteMany({ where: { collectionId: id } }),
        prisma.collection.deleteMany({ where: { id, userId: req.user.id } }),
      ]);
      invalidateDrawingsCache();
      try {
        await Promise.all(
          drawings.map((drawing) => revalidateDrawingAccess?.(drawing.id)),
        );
      } catch (error) {
        console.error("Failed to revalidate live collection access:", error);
      }

      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "collection_deleted",
          resource: `collection:${id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { collectionId: id, collectionName: collection.name },
        });
      }

      return res.json({ success: true });
    }),
  );

  // ─── Collection Sharing ───────────────────────────────────────────────────

  // GET /collections/:id/shares — list shares (owner only)
  app.get(
    "/collections/:id/shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;

      const collection = await findManageableCollection(id, req.user.id);
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      const shares = await prisma.collectionShare.findMany({
        where: { collectionId: id },
        include: {
          granteeUser: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      // Custom fork: co-owners open this dialog too, so return the real owner.
      const owner = await prisma.user.findUnique({
        where: { id: collection.userId },
        select: { id: true, name: true, email: true },
      });

      return res.json({ shares, owner });
    }),
  );

  // POST /collections/:id/shares — add or update a user share (owner only)
  app.post(
    "/collections/:id/shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const { identifier, role } = req.body as {
        identifier: string;
        role: string;
      };

      if (!identifier || !normalizeCollectionRole(role)) {
        return res
          .status(400)
          .json({ error: "identifier and role (view|edit|owner) are required" });
      }

      if (isTrashCollectionId(id, req.user.id)) {
        return res
          .status(400)
          .json({ error: "Trash collection cannot be shared" });
      }

      const collection = await findManageableCollection(id, req.user.id);
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      // Resolve user by email or username
      const grantee = await prisma.user.findFirst({
        where: {
          isActive: true,
          OR: [
            { email: identifier.toLowerCase() },
            { username: identifier },
            { name: identifier },
          ],
        },
        select: { id: true, name: true, email: true },
      });
      if (!grantee) return res.status(404).json({ error: "User not found" });
      if (grantee.id === req.user.id)
        return res.status(400).json({ error: "Cannot share with yourself" });
      if (grantee.id === collection.userId)
        return res
          .status(400)
          .json({ error: "Cannot share with the collection owner" });

      const share = await prisma.collectionShare.upsert({
        where: {
          collectionId_granteeUserId: {
            collectionId: id,
            granteeUserId: grantee.id,
          },
        },
        update: { role, updatedAt: new Date() },
        create: {
          collectionId: id,
          granteeUserId: grantee.id,
          role,
          createdByUserId: req.user.id,
        },
        include: {
          granteeUser: { select: { id: true, name: true, email: true } },
        },
      });
      invalidateDrawingsCache();
      await refreshLiveAccess(id);

      return res.json({ share });
    }),
  );

  // PATCH /collections/:id/shares/:userId — update role (owner only)
  app.patch(
    "/collections/:id/shares/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;
      const { role } = req.body as { role: string };

      if (!normalizeCollectionRole(role)) {
        return res
          .status(400)
          .json({ error: "role must be view, edit or owner" });
      }

      if (isTrashCollectionId(id, req.user.id)) {
        return res
          .status(400)
          .json({ error: "Trash collection cannot be shared" });
      }

      const collection = await findManageableCollection(id, req.user.id);
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      const share = await prisma.collectionShare.updateMany({
        where: { collectionId: id, granteeUserId: userId },
        data: { role, updatedAt: new Date() },
      });
      if (share.count === 0)
        return res.status(404).json({ error: "Share not found" });
      invalidateDrawingsCache();
      await refreshLiveAccess(id);

      return res.json({ success: true });
    }),
  );

  // DELETE /collections/:id/shares/:userId — remove a user (owner only)
  app.delete(
    "/collections/:id/shares/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;

      const collection = await findManageableCollection(id, req.user.id);
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      await prisma.collectionShare.deleteMany({
        where: { collectionId: id, granteeUserId: userId },
      });
      invalidateDrawingsCache();
      await refreshLiveAccess(id);
      return res.json({ success: true });
    }),
  );

  // GET /collections/:id/share-resolve — search users to share with (owner only)
  app.get(
    "/collections/:id/share-resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const q = String(req.query.q || "").trim();

      if (q.length < 2) return res.json({ users: [] });

      const collection = await findManageableCollection(id, req.user.id);
      if (!collection)
        return res.status(404).json({ error: "Collection not found" });

      const users = await prisma.user.findMany({
        where: {
          isActive: true,
          id: { notIn: [req.user.id, collection.userId] },
          collectionShares: { none: { collectionId: id } },
          OR: [
            { email: { contains: q } },
            { name: { contains: q } },
            { username: { contains: q } },
          ],
        },
        select: { id: true, name: true, email: true },
        take: 8,
      });

      return res.json({ users });
    }),
  );
};
