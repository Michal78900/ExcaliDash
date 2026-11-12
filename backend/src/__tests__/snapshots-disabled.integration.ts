import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/client";
import { applySceneUpdateTx } from "../routes/dashboard/sceneUpdate";
import {
  cleanupTestDb,
  createTestUser,
  getTestPrisma,
  setupTestDb,
} from "./testUtils";

const parseJsonField = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

describe("SNAPSHOTS_ENABLED switch", () => {
  let prisma: PrismaClient;
  let userId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    userId = (await createTestUser(prisma, "snapshots-switch@test.local")).id;
  });

  beforeEach(async () => cleanupTestDb(prisma));
  afterAll(async () => prisma.$disconnect());

  const createDrawing = () =>
    prisma.drawing.create({
      data: {
        userId,
        name: "Snapshot switch",
        elements: JSON.stringify([{ id: "a", type: "rectangle", version: 1 }]),
        appState: JSON.stringify({}),
        files: JSON.stringify({}),
        version: 3,
      },
    });

  const save = (drawingId: string, snapshotsEnabled: boolean) =>
    applySceneUpdateTx({
      prisma,
      drawingId,
      parseJsonField,
      versionGuard: 3,
      snapshotsEnabled,
      mutate: () => ({
        data: {
          elements: JSON.stringify([
            { id: "a", type: "rectangle", version: 2 },
          ]),
        },
      }),
    });

  it("saves the scene without writing a snapshot when disabled", async () => {
    const drawing = await createDrawing();

    const result = await save(drawing.id, false);

    expect(result.drawing.version).toBe(4);
    expect(JSON.parse(result.drawing.elements)[0].version).toBe(2);
    expect(
      await prisma.drawingSnapshot.count({ where: { drawingId: drawing.id } }),
    ).toBe(0);
  });

  it("writes a snapshot of the previous scene when enabled", async () => {
    const drawing = await createDrawing();

    await save(drawing.id, true);

    const snapshots = await prisma.drawingSnapshot.findMany({
      where: { drawingId: drawing.id },
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].version).toBe(3);
  });
});
