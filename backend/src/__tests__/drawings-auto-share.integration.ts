import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("Drawings - auto share new boards with all active users", () => {
  const userAgent = "vitest-drawings-auto-share";
  let prisma: PrismaClient;
  let app: any;

  let creator: { id: string; email: string };
  let active: { id: string; email: string };
  let inactive: { id: string; email: string };

  let creatorToken: string;
  let activeToken: string;
  let creatorAgent: any;
  let csrfHeaderName: string;
  let csrfToken: string;

  const signAccessToken = (user: { id: string; email: string }) => {
    const signOptions: SignOptions = {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
  };

  const createUser = async (email: string, isActive: boolean) => {
    const passwordHash = await bcrypt.hash("password123", 10);
    return prisma.user.create({
      data: { email, passwordHash, name: email, role: "USER", isActive },
      select: { id: true, email: true },
    });
  };

  const expectSharedWithActiveOnly = async (drawingId: string) => {
    const permissions = await prisma.drawingPermission.findMany({
      where: { drawingId },
      select: { granteeUserId: true, permission: true },
    });
    expect(permissions).toEqual([
      { granteeUserId: active.id, permission: "edit" },
    ]);
    const grantees = permissions.map((p) => p.granteeUserId);
    expect(grantees).not.toContain(inactive.id);
    expect(grantees).not.toContain(creator.id);

    const sharedResponse = await request(app)
      .get("/drawings/shared")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${activeToken}`);
    expect(sharedResponse.status).toBe(200);
    const ids = (sharedResponse.body.drawings as any[]).map((d) => d.id);
    expect(ids).toContain(drawingId);
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });

    creator = await createUser("creator-autoshare@test.local", true);
    active = await createUser("active-autoshare@test.local", true);
    inactive = await createUser("inactive-autoshare@test.local", false);

    creatorToken = signAccessToken(creator);
    activeToken = signAccessToken(active);

    creatorAgent = request.agent(app);
    const csrfRes = await creatorAgent
      .get("/csrf-token")
      .set("User-Agent", userAgent);
    csrfHeaderName = csrfRes.body.header;
    csrfToken = csrfRes.body.token;
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("grants edit access to every other active user when a drawing is created", async () => {
    const response = await creatorAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${creatorToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({ name: "Auto shared", elements: [], appState: {} });

    expect(response.status).toBe(200);
    await expectSharedWithActiveOnly(response.body.id);
  });

  it("grants edit access to every other active user when a drawing is duplicated", async () => {
    const original = await prisma.drawing.create({
      data: {
        name: "Original",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: creator.id,
      },
      select: { id: true },
    });

    const response = await creatorAgent
      .post(`/drawings/${original.id}/duplicate`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${creatorToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({});

    expect(response.status).toBe(200);
    await expectSharedWithActiveOnly(response.body.id);
  });
});
