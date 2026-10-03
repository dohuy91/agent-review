import { fireEvent, screen, within } from "@testing-library/react";
export function openSettings(tab = "Git") {
  fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
  const dialog = screen.getByRole("dialog", { name: "Project settings" });
  fireEvent.click(within(dialog).getByRole("tab", { name: tab }));
  return dialog;
}
export function chooseTheme(theme: string) {
  const dialog = openSettings("Appearance");
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Theme" }), {
    target: { value: theme },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
}
export function selectedTheme() {
  const dialog = openSettings("Appearance"),
    value = (
      within(dialog).getByRole("combobox", {
        name: "Theme",
      }) as HTMLSelectElement
    ).value;
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  return value;
}
export function openProfiles() {
  const dialog = openSettings("Agents");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Advanced fix profiles" }),
  );
}
export function advancedBase() {
  const dialog = openSettings("Git");
  const summary = within(dialog).getByText("Advanced Git comparison");
  fireEvent.click(summary);
  const details = summary.closest("details")!;
  details.open = true;
  return within(dialog).getByLabelText("Base reference");
}
export function chooseBase(value: string) {
  fireEvent.change(advancedBase(), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
}
export function openFileActions() {
  const button = screen.getByRole("button", { name: "File actions" });
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
}
export function selectedProject(rootName: string) {
  return (
    screen
      .getByRole("tab", { name: rootName })
      .getAttribute("aria-selected") === "true"
  );
}
