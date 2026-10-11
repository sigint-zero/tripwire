import { useEffect, useRef, useState } from "react";

/**
 * A list's search box. Once typing pauses it writes the query to the URL,
 * which the list filters by, so a search can be linked and survives a reload.
 * "/" anywhere on the page focuses it; Escape clears it.
 */
export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  /** The query kept in the URL. */
  value: string | undefined;
  onChange: (query: string | undefined) => void;
  /** What is searched, for screen readers: "Search rules". */
  label: string;
  placeholder: string;
}) {
  const [text, setText] = useState(value ?? "");
  const input = useRef<HTMLInputElement>(null);
  // What this box last wrote, so its own write never overwrites newer typing.
  const sent = useRef(value);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });

  // Follow the URL when it changes from elsewhere: back, a link, Clear.
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value ?? "");
    }
  }, [value]);

  // Write the query once typing pauses, not at every key.
  useEffect(() => {
    const next = text.trim() ? text : undefined;
    if (next === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = next;
      change.current(next);
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable=true]") ||
        document.querySelector("dialog[open]")
      ) {
        return;
      }
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);

  const clear = () => {
    setText("");
    sent.current = undefined;
    onChange(undefined);
  };

  return (
    <div className="relative w-full md:w-72">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-gray-500"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3.5 3.5" />
      </svg>
      <input
        ref={input}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            clear();
          }
        }}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-full bg-white/3 py-2.5 pr-16 pl-9 text-xs text-gray-200 placeholder:text-gray-600 transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {text ? (
        <button
          type="button"
          onClick={() => {
            clear();
            input.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer px-1.5 text-sm text-gray-500 transition-colors hover:text-gray-200"
        >
          ×
        </button>
      ) : (
        <kbd
          aria-hidden="true"
          title="Press / to search"
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 border border-white/10 px-1.5 font-mono text-[10px] text-gray-600"
        >
          /
        </kbd>
      )}
    </div>
  );
}

/** "3 of 42 rules" while searching, nothing otherwise. */
export function SearchCount({
  query,
  shown,
  total,
  noun,
}: {
  query: string | undefined;
  shown: number;
  total: number;
  noun: [one: string, many: string];
}) {
  if (!query) return null;
  return (
    <p className="text-xs text-gray-500 tabular-nums" aria-live="polite">
      {shown} of {total} {total === 1 ? noun[0] : noun[1]}
    </p>
  );
}
