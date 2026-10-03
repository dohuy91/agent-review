// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PaneSeparator from "../apps/web/src/components/PaneSeparator.js";

beforeEach(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

async function separator(side: "left" | "right" = "left") {
  const onResize = vi.fn(),
    onReset = vi.fn();
  const props = {
    side,
    label: "Resize review navigation",
    controls: "navigation-pane",
    value: 205,
    min: 160,
    max: 420,
    onResize,
    onReset,
  };
  const Component = PaneSeparator;
  const view = render(<Component {...props} />);
  const handle = screen.getByRole("separator", { name: props.label });
  return { ...view, handle, onResize, onReset, props, Component };
}

test("the focusable vertical separator exposes its controlled pane and bounded pixel value", async () => {
  const { handle } = await separator();
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  expect(handle.getAttribute("aria-controls")).toBe("navigation-pane");
  expect(handle.getAttribute("aria-valuenow")).toBe("205");
  expect(handle.getAttribute("aria-valuemin")).toBe("160");
  expect(handle.getAttribute("aria-valuemax")).toBe("420");
  expect(handle.getAttribute("aria-valuetext")).toBe("205 pixels");
  expect(handle.tabIndex).toBe(0);
});

test("keyboard arrows move the left divider and stop at its bounds", async () => {
  const { handle, onResize } = await separator();
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onResize).toHaveBeenLastCalledWith(215);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(onResize).toHaveBeenLastCalledWith(195);
  fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
  expect(onResize).toHaveBeenLastCalledWith(160);
  fireEvent.keyDown(handle, { key: "x" });
  expect(onResize).toHaveBeenCalledTimes(3);
});

test("the right divider grows its pane when moved left", async () => {
  const { handle, onResize } = await separator("right");
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(onResize).toHaveBeenLastCalledWith(215);
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onResize).toHaveBeenLastCalledWith(195);
});

test("Home and double click reset the pane to its default", async () => {
  const { handle, onReset } = await separator();
  fireEvent.keyDown(handle, { key: "Home" });
  fireEvent.doubleClick(handle);
  expect(onReset).toHaveBeenCalledTimes(2);
});

test("dragging continues outside the divider, ignores other pointers, and releases on pointer up", async () => {
  const { handle, onResize } = await separator();
  document.body.style.cursor = "text";
  document.body.style.userSelect = "auto";
  fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 200 });
  expect(document.body.style.cursor).toBe("col-resize");
  expect(document.body.style.userSelect).toBe("none");
  fireEvent.pointerMove(window, { pointerId: 3, clientX: 400 });
  expect(onResize).not.toHaveBeenCalled();
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 500 });
  expect(onResize).toHaveBeenLastCalledWith(420);
  fireEvent.pointerUp(window, { pointerId: 3 });
  expect(document.body.style.cursor).toBe("col-resize");
  fireEvent.pointerUp(window, { pointerId: 2 });
  expect(document.body.style.cursor).toBe("text");
  expect(document.body.style.userSelect).toBe("auto");
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 150 });
  expect(onResize).toHaveBeenCalledTimes(1);
});

test("right-pane pointer resizing follows the physical divider direction", async () => {
  const { handle, onResize } = await separator("right");
  fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 600 });
  fireEvent.pointerMove(window, { pointerId: 4, clientX: 550 });
  expect(onResize).toHaveBeenLastCalledWith(255);
  fireEvent.pointerMove(window, { pointerId: 4, clientX: 900 });
  expect(onResize).toHaveBeenLastCalledWith(160);
});

test.each(["pointercancel", "blur"])(
  "%s terminates a drag and restores selection",
  async (type) => {
    const { handle, onResize } = await separator();
    fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 200 });
    fireEvent(
      window,
      type === "blur"
        ? new Event("blur")
        : new PointerEvent(type, { pointerId: 7 }),
    );
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 });
    expect(onResize).not.toHaveBeenCalled();
  },
);

test("unmount cleans up an active drag", async () => {
  const { handle, unmount, onResize } = await separator();
  fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 200 });
  unmount();
  expect(document.body.style.cursor).toBe("");
  expect(document.body.style.userSelect).toBe("");
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 });
  expect(onResize).not.toHaveBeenCalled();
});

test("losing pointer capture ends the drag without leaving selection disabled", async () => {
  const { handle, onResize } = await separator();
  fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 200 });
  fireEvent(
    handle,
    new PointerEvent("lostpointercapture", { pointerId: 7, bubbles: true }),
  );
  expect(document.body.style.userSelect).toBe("");
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 });
  expect(onResize).not.toHaveBeenCalled();
});

test("disabled rail separators cannot resize, reset, or retain an active drag", async () => {
  const { handle, onResize, onReset, rerender, Component, props } =
    await separator();
  fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 200 });
  rerender(<Component {...props} disabled />);
  expect(handle.tabIndex).toBe(-1);
  expect(handle.getAttribute("aria-disabled")).toBe("true");
  expect(document.body.style.cursor).toBe("");
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 });
  fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 200 });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  fireEvent.keyDown(handle, { key: "Home" });
  fireEvent.doubleClick(handle);
  expect(onResize).not.toHaveBeenCalled();
  expect(onReset).not.toHaveBeenCalled();
});

test("non-primary mouse buttons do not start resizing", async () => {
  const { handle, onResize } = await separator();
  fireEvent.pointerDown(handle, { pointerId: 7, button: 2, clientX: 200 });
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 });
  expect(onResize).not.toHaveBeenCalled();
  expect(document.body.style.cursor).toBe("");
});
