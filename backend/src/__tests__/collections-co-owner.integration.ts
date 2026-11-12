import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

// Custom fork: shared folders. Editors of a drawing may file it into
// collections they own, co-own or can edit; collections can have co-owners;
// new collections are shared with all active users.
describe("Collections - shared folders and co-owners", () => {
  const userAgent = "vitest-collections-co-owner";
  let prisma: PrismaClient;
  let app: any;

  type Actor = {
    id: string;
    email: string;
    token: string;
    agent: any;
    csrfHeader: string;
    csrfToken: string;
  };
  let owner: Actor;
  let editor: Actor;
  let viewer: Actor;

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

  const createActor = async (email: string): Promise<Actor> => {
    const passwordHash = await bcrypt.hash("password123", 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, name: email, role: "USER", isActive: true },
      select: { id: true, email: true },
    });
    const agent = request.agent(app);
    const csrfRes = await agent.get("/csrf-token").set("User-Agent", userAgent);
    return {
      ...user,
      token: signAccessToken(user),
      agent,
      csrfHeader: csrfRes.body.header,
      csrfToken: csrfRes.body.token,
    };
  };

  const send = (
    actor: Actor,
    method: "get" | "post" | "put" | "patch" | "delete",
    url: string,
  ) => {
    const req = actor.agent[method](url)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${actor.token}`);
    return method === "get" ? req : req.set(actor.csrfHeader, actor.csrfToken);
  };

  // Collection owned by `ownerId`, explicitly shared (no auto-share).
  const createCollection = async (
    ownerId: string,
    shares: Array<{ userId: string; role: string }> = [],
  ) => {
    const collection = await prisma.collection.create({
      data: { name: "Folder", userId: ownerId },
      select: { id: true },
    });
    for (const s of shares) {
      await prisma.collectionShare.create({
        data: {
          collectionId: collection.id,
          granteeUserId: s.userId,
          role: s.role,
          createdByUserId: ownerId,
        },
      });
    }
    return collection;
  };

  const createDrawing = async (
    grants: Array<{ userId: string; permission: string }>,
    collectionId: string | null = null,
  ) => {
    const drawing = await prisma.drawing.create({
      data: {
        name: "Board",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: owner.id,
        collectionId,
      },
      select: { id: true },
    });
    for (const g of grants) {
      await prisma.drawingPermission.create({
        data: {
          drawingId: drawing.id,
          granteeUserId: g.userId,
          permission: g.permission,
          createdByUserId: owner.id,
        },
      });
    }
    return drawing;
  };

  const moveDrawing = (
    actor: Actor,
    drawingId: string,
    collectionId: string | null,
  ) => send(actor, "put", `/drawings/${drawingId}`).send({ collectionId });

  const sharedWithMeIds = async (actor: Actor) => {
    const res = await send(actor, "get", "/drawings/shared");
    expect(res.status).toBe(200);
    return (res.body.drawings as any[]).map((d) => d.id);
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

    owner = await createActor("owner-coowner@test.local");
    editor = await createActor("editor-coowner@test.local");
    viewer = await createActor("viewer-coowner@test.local");
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("shares a newly created collection with all other active users as editors", async () => {
    const res = await send(owner, "post", "/collections").send({
      name: "Team folder",
    });
    expect(res.status).toBe(200);

    const shares = await prisma.collectionShare.findMany({
      where: { collectionId: res.body.id },
      select: { granteeUserId: true, role: true },
      orderBy: { granteeUserId: "asc" },
    });
    expect(shares).toHaveLength(2);
    expect(shares.map((s) => s.granteeUserId).sort()).toEqual(
      [editor.id, viewer.id].sort(),
    );
    expect(shares.every((s) => s.role === "edit")).toBe(true);
  });

  it("lets a drawing editor file a shared drawing into a shared folder", async () => {
    const folder = await createCollection(owner.id, [
      { userId: editor.id, role: "edit" },
    ]);
    const drawing = await createDrawing([
      { userId: editor.id, permission: "edit" },
    ]);
    expect(await sharedWithMeIds(editor)).toContain(drawing.id);

    const res = await moveDrawing(editor, drawing.id, folder.id);
    expect(res.status).toBe(200);
    const stored = await prisma.drawing.findUnique({
      where: { id: drawing.id },
    });
    expect(stored?.collectionId).toBe(folder.id);

    expect(await sharedWithMeIds(editor)).not.toContain(drawing.id);
    const list = await send(
      editor,
      "get",
      `/drawings?collectionId=${folder.id}`,
    );
    expect(list.status).toBe(200);
    expect((list.body.drawings as any[]).map((d) => d.id)).toContain(
      drawing.id,
    );
  });

  it("lets an editor file someone else's drawing into their own folder without becoming its owner", async () => {
    const editorFolder = await createCollection(editor.id);
    const drawing = await createDrawing([
      { userId: editor.id, permission: "edit" },
    ]);

    const res = await moveDrawing(editor, drawing.id, editorFolder.id);
    expect(res.status).toBe(200);
    expect(await sharedWithMeIds(editor)).not.toContain(drawing.id);

    const read = await send(editor, "get", `/drawings/${drawing.id}`);
    expect(read.status).toBe(200);
    expect(read.body.accessLevel).toBe("edit");

    const trash = await moveDrawing(editor, drawing.id, "trash");
    expect(trash.status).toBe(403);
    const del = await send(editor, "delete", `/drawings/${drawing.id}`);
    expect(del.status).toBe(404);
    const sharing = await send(editor, "get", `/drawings/${drawing.id}/sharing`);
    expect(sharing.status).toBe(404);
  });

  it("rejects moves by viewers and into view-only folders", async () => {
    const viewOnlyFolder = await createCollection(owner.id, [
      { userId: editor.id, role: "view" },
      { userId: viewer.id, role: "edit" },
    ]);
    const drawing = await createDrawing([
      { userId: editor.id, permission: "edit" },
      { userId: viewer.id, permission: "view" },
    ]);

    const byViewer = await moveDrawing(viewer, drawing.id, viewOnlyFolder.id);
    expect([403, 404]).toContain(byViewer.status);

    const intoViewOnly = await moveDrawing(
      editor,
      drawing.id,
      viewOnlyFolder.id,
    );
    expect(intoViewOnly.status).toBe(404);

    const stored = await prisma.drawing.findUnique({
      where: { id: drawing.id },
    });
    expect(stored?.collectionId).toBeNull();
  });

  it("does not let an editor pull a drawing out of the owner's private folder", async () => {
    const privateFolder = await createCollection(owner.id);
    const editorFolder = await createCollection(editor.id);
    const drawing = await createDrawing(
      [{ userId: editor.id, permission: "edit" }],
      privateFolder.id,
    );

    const res = await moveDrawing(editor, drawing.id, editorFolder.id);
    expect(res.status).toBe(403);
    const stored = await prisma.drawing.findUnique({
      where: { id: drawing.id },
    });
    expect(stored?.collectionId).toBe(privateFolder.id);
  });

  it("lets a co-owner rename and manage shares but not delete the folder", async () => {
    const folder = await createCollection(owner.id, [
      { userId: editor.id, role: "owner" },
    ]);

    const list = await send(editor, "get", "/collections");
    const entry = (list.body as any[]).find((c) => c.id === folder.id);
    expect(entry?.isOwner).toBe(false);
    expect(entry?.sharedRole).toBe("owner");

    const rename = await send(editor, "put", `/collections/${folder.id}`).send({
      name: "Renamed by co-owner",
    });
    expect(rename.status).toBe(200);
    expect(rename.body.name).toBe("Renamed by co-owner");

    const share = await send(
      editor,
      "post",
      `/collections/${folder.id}/shares`,
    ).send({ identifier: viewer.email, role: "view" });
    expect(share.status).toBe(200);

    const sharesList = await send(
      editor,
      "get",
      `/collections/${folder.id}/shares`,
    );
    expect(sharesList.status).toBe(200);
    expect(sharesList.body.owner?.id).toBe(owner.id);

    const shareOwner = await send(
      editor,
      "post",
      `/collections/${folder.id}/shares`,
    ).send({ identifier: owner.email, role: "view" });
    expect(shareOwner.status).toBe(400);

    const del = await send(editor, "delete", `/collections/${folder.id}`);
    expect(del.status).toBe(404);

    const byViewer = await send(viewer, "put", `/collections/${folder.id}`).send(
      { name: "Nope" },
    );
    expect(byViewer.status).toBe(404);
  });

  it("unfiles drawings of all owners when a folder is deleted", async () => {
    const folder = await createCollection(owner.id, [
      { userId: editor.id, role: "edit" },
    ]);
    const editorDrawing = await prisma.drawing.create({
      data: {
        name: "Editor board",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: editor.id,
        collectionId: folder.id,
      },
      select: { id: true },
    });

    const del = await send(owner, "delete", `/collections/${folder.id}`);
    expect(del.status).toBe(200);

    const stored = await prisma.drawing.findUnique({
      where: { id: editorDrawing.id },
    });
    expect(stored?.collectionId).toBeNull();
  });
});
