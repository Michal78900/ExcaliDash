import React, { useLayoutEffect } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useEditorBroadcast } from "../src/pages/editor/useEditorBroadcast";
import { useEditorElementTracking } from "../src/pages/editor/useEditorElementTracking";

const ref = <T,>(current: T) => ({ current });
const element = (id: string, version = 1, extra = {}) => ({
  id,
  type: "rectangle",
  version,
  versionNonce: version * 7,
  updated: 1,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
  isDeleted: false,
  ...extra,
});

const setup = () => {
  const emit = vi.fn();
  const debouncedSave = vi.fn();
  const hooks = ref<{
    broadcast: (elements: readonly any[], files?: Record<string, any>) => void;
    tracking: ReturnType<typeof useEditorElementTracking>;
    hasElementChanged: ReturnType<typeof vi.fn>;
  } | null>(null);
  const refs = {
    excalidrawAPI: ref<any>(null),
    lastSyncedElementOrderRef: ref<readonly string[] | null>(null),
    lastSyncedFilesRef: ref<Record<string, any>>({}),
    latestAppStateRef: ref<any>({}),
    latestFilesRef: ref<any>(null),
    socketMeRef: ref({ id: "me" }),
    socketRef: ref<any>({ emit }),
    uploadedRefs: ref<Record<string, string>>({}),
  };
  const Harness = () => {
    const tracking = useEditorElementTracking();
    const hasElementChanged = React.useMemo(
      () => vi.fn(tracking.hasElementChanged),
      [tracking.hasElementChanged],
    );
    const { broadcastChanges: broadcast } = useEditorBroadcast({
      drawingId: "d1",
      ...refs,
      debouncedSave,
      debouncedSavePreview: vi.fn(),
      computeElementsFingerprint: tracking.computeElementsFingerprint,
      elementVersionMap: tracking.elementVersionMap,
      trackingEpochRef: tracking.trackingEpochRef,
      hasElementChanged,
      recordElementVersion: tracking.recordElementVersion,
      markSceneChanged: vi.fn(),
    });
    useLayoutEffect(() => {
      hooks.current = { broadcast, tracking, hasElementChanged };
    });
    return null;
  };
  act(() => {
    create(<Harness />);
  });
  let now = 1_000_000;
  vi.spyOn(Date.prototype, "getTime").mockImplementation(() => (now += 1000));
  return { emit, debouncedSave, refs, get: () => hooks.current! };
};

describe("useEditorBroadcast fast path", () => {
  it("skips the per-element scan when only non-element state changed", () => {
    const { emit, get } = setup();
    const files = {};
    const elements = [element("a"), element("b")];
    get().broadcast(elements, files);
    expect(emit).toHaveBeenCalledTimes(1);
    get().hasElementChanged.mockClear();

    get().broadcast(elements, files);
    get().broadcast([...elements], files);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(get().hasElementChanged).not.toHaveBeenCalled();
  });

  it("emits a changed element after a fast-path skip", () => {
    const { emit, get } = setup();
    const files = {};
    get().broadcast([element("a"), element("b")], files);
    get().broadcast([element("a"), element("b")], files);
    get().broadcast([element("a"), element("b", 2)], files);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1].elements.map((e: any) => e.id)).toEqual([
      "b",
    ]);
  });

  it("rescans when a version is recorded from outside (remote merge)", () => {
    const { emit, get } = setup();
    const files = {};
    const elements = [element("a"), element("b")];
    get().broadcast(elements, files);
    // A rejected remote packet got acknowledged; the local element must be
    // re-sent even though the local scene did not change.
    get().tracking.recordElementVersion(element("b", 5));
    get().hasElementChanged.mockClear();
    get().broadcast(elements, files);
    expect(get().hasElementChanged).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1].elements.map((e: any) => e.id)).toEqual([
      "b",
    ]);
  });

  it("still syncs new files when elements are unchanged", () => {
    const { emit, get } = setup();
    const elements = [element("a")];
    get().broadcast(elements, {});
    get().broadcast(elements, {
      f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA" },
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][1].elements).toEqual([]);
    expect(Object.keys(emit.mock.calls[1][1].files)).toEqual(["f1"]);
  });
});
