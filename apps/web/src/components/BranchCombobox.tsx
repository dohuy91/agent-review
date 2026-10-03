import React, { useEffect, useId, useState } from "react";

export type BranchChoice = { value: string; label: string; disabled?: boolean };

/** Search is local state; only a listed option can become a Git reference. */
export default function BranchCombobox({
  label,
  value,
  options,
  onChange,
  placeholder = "Search branches",
  disabled = false,
}: {
  label: string;
  value: string;
  options: BranchChoice[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const enabledIndices = filtered.flatMap((option, index) =>
    option.disabled ? [] : [index],
  );
  const activeIndex =
    filtered[active] && !filtered[active].disabled
      ? active
      : (enabledIndices[0] ?? -1);
  useEffect(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, [value, disabled]);
  function close() {
    setOpen(false);
    setQuery("");
  }
  function commit(option: BranchChoice | undefined) {
    if (!option || option.disabled) return;
    close();
    onChange(option.value);
  }
  return (
    <div className="branch-picker">
      <label htmlFor={id}>{label}</label>
      <div className="branch-picker-input">
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-activedescendant={
            open && filtered[activeIndex]
              ? `${id}-option-${activeIndex}`
              : undefined
          }
          title={value || placeholder}
          value={open ? query : value}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onBlur={close}
          onChange={(event) => {
            setOpen(true);
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                setQuery("");
                const enabled = options.flatMap((option, index) =>
                  option.disabled ? [] : [index],
                );
                setActive(
                  event.key === "ArrowUp"
                    ? (enabled.at(-1) ?? -1)
                    : (enabled[0] ?? -1),
                );
              } else if (enabledIndices.length) {
                const position = enabledIndices.indexOf(activeIndex);
                setActive(
                  enabledIndices[
                    (position +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      enabledIndices.length) %
                      enabledIndices.length
                  ],
                );
              }
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (open) commit(filtered[activeIndex]);
              else {
                setOpen(true);
                setQuery("");
                setActive(0);
              }
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        />
        <span aria-hidden="true">⌄</span>
      </div>
      {value && (
        <div className="selected-branch" title={value}>
          {value}
        </div>
      )}
      {open && (
        <div
          className="branch-options"
          id={`${id}-options`}
          role="listbox"
          aria-label={`${label} options`}
        >
          {filtered.map((option, index) => (
            <button
              key={option.value}
              id={`${id}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={value === option.value}
              data-ref={option.value}
              className={activeIndex === index ? "active" : ""}
              disabled={option.disabled}
              aria-disabled={option.disabled || undefined}
              title={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => commit(option)}
            >
              {option.label}
            </button>
          ))}
          {!filtered.length && <p role="status">No matching branches</p>}
        </div>
      )}
    </div>
  );
}
