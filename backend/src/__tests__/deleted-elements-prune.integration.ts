import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import type { Server } from "socket.io";
import type { PrismaClient } from "../generated/client";
import { registerDrawingCreateUpdateRoutes } from "../routes/dashboard/drawingCreateUpdateRoutes";
import type { DrawingRouteContext } from "../routes/dashboard/drawingRouteContext";
import { pruneDeletedElements } from "../routes/dashboard/sceneMerge";
import { cleanupTestDb, getTestPrisma, setupTestDb } from "./testUtils";

// Custom fork: tombstones of elements deleted long ago are dropped on autosave.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("pruneDeletedElements", () => {
  const now = 1_000 * DAY;
  const ids = (elements: unknown[]) =>
    elements.map((el) => (el as { id: string }).id);

  it("drops only tombstones older than the retention window", () => {
    const pruned = pruneDeletedElements(
      [
        { id: "old-deleted", isDeleted: true, updated: now - 25 * HOUR },
        { id: "fresh-deleted", isDeleted: true, updated: now - HOUR },
        { id: "no-updated", isDeleted: true },
        { id: "old-alive", isDeleted: false, updated: now - 30 * DAY },
        { id: "alive", updated: now },
      ],
      DAY,
      now,
    );
    expect(ids(pruned)).toEqual([
      "fresh-deleted",
      "no-updated",
      "old-alive",
      "alive",
    ]);
  });

  it("keeps everything when retention is 0", () => {
    const elements = [{ id: "a", isDeleted: true, updated: 0 }];
    expect(pruneDeletedElements(elements, 0, now)).toEqual(elements);
  });
});

describe("autosave prunes expired tombstones", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  let app: express.Express;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const owner = await prisma.user.create({
      data: {
        email: "prune@test.local",
        passwordHash: "unused",
        name: "Owner",
      },
    });
    ownerId = owner.id;
    const auth: express.RequestHandler = (req, _res, next) => {
      req.user = { id: ownerId } as express.Request["user"];
      next();
    };
    app = express();
    app.use(express.json());
    registerDrawingCreateUpdateRoutes(app, {
      prisma,
      requireAuth: auth,
      optionalAuth: auth,
      asyncHandler: (handler) => (req, res, next) => {
        void handler(req, res, next).catch(next);
      },
      parseJsonField: (raw, fallback) => (raw ? JSON.parse(raw) : fallback),
      drawingUpdateSchema: z.object({
        elements: z.array(z.any()).optional(),
        version: z.number().optional(),
        autosave: z.boolean().optional(),
      }),
      getRequestPrincipal: async () => ({ kind: "user", userId: ownerId }),
      respondWithAuthErrorIfPresent: () => false,
      invalidateDrawingsCache: vi.fn(),
      config: { nodeEnv: "test" },
      internDrawingFiles: async (files) => files,
      ensureTrashCollection: async () => undefined,
      revalidateDrawingAccess: vi.fn(),
      io: { to: () => ({ emit: vi.fn() }) } as unknown as Server,
    } as DrawingRouteContext);
  });

  beforeEach(async () => cleanupTestDb(prisma));
  afterAll(async () => prisma.$disconnect());

  it("removes old tombstones from both the stored and the incoming scene", async () => {
    const now = Date.now();
    const drawing = await prisma.drawing.create({
      data: {
        userId: ownerId,
        name: "Prune",
        elements: JSON.stringify([
          {
            id: "stored-old",
            version: 5,
            isDeleted: true,
            updated: now - 2 * DAY,
          },
          {
            id: "stored-fresh",
            version: 5,
            isDeleted: true,
            updated: now - HOUR,
          },
        ]),
        appState: "{}",
        files: "{}",
        version: 1,
      },
    });

    const response = await request(app)
      .put(`/drawings/${drawing.id}`)
      .send({
        autosave: true,
        elements: [
          {
            id: "incoming-old",
            version: 3,
            isDeleted: true,
            updated: now - 2 * DAY,
          },
          { id: "kept", version: 1, updated: now - 3 * DAY },
        ],
      });
    expect(response.status).toBe(200);

    const saved = await prisma.drawing.findUniqueOrThrow({
      where: { id: drawing.id },
    });
    const savedIds = (JSON.parse(saved.elements) as { id: string }[])
      .map((el) => el.id)
      .sort();
    expect(savedIds).toEqual(["kept", "stored-fresh"]);
  });
});
