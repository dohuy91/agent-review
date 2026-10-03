// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { usePaneLayout } from "../apps/web/src/usePaneLayout.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function layoutHook(initial = { left: 205, right: 270 }, width = 1200) {
  vi.stubGlobal("innerWidth", width);
  const workspace = document.createElement("div");
  let measuredWidth = width;
  workspace.getBoundingClientRect = () => ({ width: measuredWidth }) as DOMRect;
  const ref = { current: workspace };
  const hook = renderHook(() => usePaneLayout(ref, initial));
  function resize(viewport: number, container = viewport) {
    measuredWidth = container;
    vi.stubGlobal("innerWidth", viewport);
    fireEvent(window, new Event("resize"));
  }
  return {
    ...hook,
    resize,
    workspace,
    measure: (width: number) => {
      measuredWidth = width;
    },
  };
}

test("layout measures available width and exposes five-column grid sizing", async () => {
  const { result } = await layoutHook();
  expect(result.current.desktop).toBe(true);
  expect(result.current.widths).toEqual({ left: 205, right: 270 });
  expect(result.current.gridTemplateColumns).toBe(
    "205px 5px minmax(0, 1fr) 5px 270px",
  );
  expect(result.current.bounds.left).toEqual({ min: 160, max: 420 });
});

test("resize bounds preserve the diff and shrinking the window retains remembered widths", async () => {
  const { result, resize } = await layoutHook({ left: 360, right: 480 });
  resize(901);
  expect(result.current.widths).toEqual({ left: 360, right: 251 });
  expect(result.current.preferredWidths).toEqual({ left: 360, right: 480 });
  resize(1200);
  expect(result.current.widths).toEqual({ left: 360, right: 480 });
  act(() => result.current.resizePane("left", 999));
  expect(result.current.widths.left).toBe(420);
  expect(result.current.preferredWidths.left).toBe(420);
  act(() => result.current.resetPane("left"));
  expect(result.current.preferredWidths.left).toBe(205);
});

test("700px and 900px widths use rails and ignore desktop resizing", async () => {
  const { result, resize } = await layoutHook();
  resize(900);
  expect(result.current.desktop).toBe(false);
  expect(result.current.gridTemplateColumns).toBe("minmax(0, 1fr)");
  act(() => result.current.resizePane("right", 400));
  expect(result.current.preferredWidths.right).toBe(270);
  resize(700);
  expect(result.current.desktop).toBe(false);
  resize(901);
  expect(result.current.desktop).toBe(true);
});

test("workspace measurement limits panes independently of the viewport", async () => {
  const { result, resize } = await layoutHook({ left: 360, right: 480 });
  resize(1400, 1000);
  expect(result.current.widths).toEqual({ left: 360, right: 350 });
  expect(result.current.bounds.left.max).toBe(360);
});

test("container-only resizes refit the panes and release the observer on unmount", async () => {
  const observers: {
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({
          callback,
          observe: this.observe,
          disconnect: this.disconnect,
        });
      }
    },
  );
  const { result, workspace, measure, unmount } = await layoutHook({
    left: 360,
    right: 480,
  });
  expect(observers[0].observe).toHaveBeenCalledWith(workspace);
  measure(901);
  act(() => observers[0].callback([], {} as ResizeObserver));
  expect(result.current.widths).toEqual({ left: 360, right: 251 });
  unmount();
  expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
});
