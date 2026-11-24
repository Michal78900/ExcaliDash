import React, { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "../src/pages/editor/EditorView";
import { useEditorChrome } from "../src/pages/editor/useEditorChrome";

vi.mock("react-dom", () => ({
  createPortal: (children: React.ReactNode) => children,
}));
vi.mock("@excalidraw/excalidraw", () => {
  const Item = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    Excalidraw: (props: Record<string, unknown>) =>
      React.createElement("mock-canvas", props),
    MainMenu: Object.assign(Item, {
      Item,
      ItemCustom: Item,
      Separator: () => null,
      DefaultItems: {
        SaveAsImage: () => null,
        ClearCanvas: () => null,
        ChangeCanvasBackground: () => null,
        Help: () => null,
      },
    }),
  };
});
vi.mock("../src/components/ShareModal", () => ({ ShareModal: () => null }));
vi.mock("../src/components/LanguageSelector", () => ({
  LanguageSelector: () => null,
}));
vi.mock("../src/components/GridStepSelector", () => ({
  GridStepSelector: () => null,
}));
vi.mock("../src/components/UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("sonner", () => ({ Toaster: () => null }));

const ref = <T,>(current: T) => ({ current });
const renderers: ReactTestRenderer[] = [];
const render = async (element: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  renderers.push(renderer);
  return renderer;
};

let storage: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  storage = new Map();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      setTimeout,
      clearTimeout,
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    }),
  );
  vi.stubGlobal("document", { body: {}, title: "" });
});
afterEach(async () => {
  await act(async () => {
    renderers.splice(0).forEach((renderer) => renderer.unmount());
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type ViewOverrides = Partial<React.ComponentProps<typeof EditorView>>;
const view = (overrides: ViewOverrides = {}) => (
  <EditorView
    id="drawing"
    accessLevel="view"
    canEdit={false}
    historyEnabled={false}
    autoHideEnabled={false}
    autosaveFailing={false}
    drawingName="Drawing"
    editorContainerRef={ref(null)}
    initialData={{ elements: [] }}
    isHeaderVisible
    isHistoryOpen={false}
    historyPreview={null}
    historyButtonRef={ref(null)}
    shareButtonRef={ref(null)}
    isRenaming={false}
    isSavingOnLeave={false}
    isSceneLoading={false}
    langCode="en"
    loadError={null}
    me={{ id: "me", name: "Me", color: "red" }}
    newName="Drawing"
    peers={[]}
    followedUserId={null}
    onToggleFollow={vi.fn()}
    theme="light"
    onBackClick={vi.fn()}
    onBackIntent={vi.fn()}
    onCanvasChange={vi.fn()}
    onCanvasDropCapture={vi.fn()}
    onExportClick={vi.fn()}
    onLibraryChange={vi.fn()}
    onNavigateHome={vi.fn()}
    onNewNameChange={vi.fn()}
    onPointerUpdate={vi.fn()}
    onRenameCancel={vi.fn()}
    onRenameStart={vi.fn()}
    onRenameSubmit={vi.fn()}
    onSetExcalidrawAPI={vi.fn()}
    onSetLangCode={vi.fn()}
    gridStep={20}
    onSetGridStep={vi.fn()}
    onShareOpen={vi.fn()}
    isShareOpen={false}
    onCloseShare={vi.fn()}
    onHistoryOpen={vi.fn()}
    onToggleAutoHide={vi.fn()}
    onToggleTheme={vi.fn()}
    {...overrides}
  />
);

const notices = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) => node.props["data-testid"] === "read-only-notice",
  );

describe("read-only notice", () => {
  it("explains why the tools are missing for a view-only visitor", async () => {
    const renderer = await render(view());
    expect(notices(renderer)).toHaveLength(1);
    expect(
      renderer.root.findByType("mock-canvas" as React.ElementType).props
        .viewModeEnabled,
    ).toBe(true);
  });

  it("stays hidden for editors, while loading, and during history preview", async () => {
    const renderer = await render(view({ accessLevel: "edit", canEdit: true }));
    expect(notices(renderer)).toHaveLength(0);
    await act(async () => renderer.update(view({ accessLevel: "none" })));
    expect(notices(renderer)).toHaveLength(0);
    await act(async () => renderer.update(view({ initialData: null })));
    expect(notices(renderer)).toHaveLength(0);
    await act(async () => renderer.update(view({ isHistoryOpen: true })));
    expect(notices(renderer)).toHaveLength(0);
  });

  it("remembers a dismissal for the drawing in session storage", async () => {
    const renderer = await render(view());
    const dismiss = notices(renderer)[0].findByProps({
      "aria-label": "Dismiss",
    });
    await act(async () => dismiss.props.onClick());
    expect(notices(renderer)).toHaveLength(0);
    expect(storage.size).toBe(1);

    const again = await render(view());
    expect(notices(again)).toHaveLength(0);
    const other = await render(view({ id: "other" }));
    expect(notices(other)).toHaveLength(1);
  });
});

describe("pinned header", () => {
  it("keeps the header visible when pinned even with auto-hide on", async () => {
    let visible = true;
    function Chrome({ pinned }: { pinned: boolean }) {
      const chrome = useEditorChrome({
        drawingName: "Drawing",
        autoHideEnabled: true,
        isRenaming: false,
        isShareOpen: false,
        pinned,
      });
      useLayoutEffect(() => {
        visible = chrome.isHeaderVisible;
      });
      return null;
    }
    const renderer = await render(<Chrome pinned />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(visible).toBe(true);
    await act(async () => renderer.update(<Chrome pinned={false} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(visible).toBe(false);
  });
});
