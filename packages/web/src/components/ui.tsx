import type { ButtonHTMLAttributes, ReactNode } from "react";

const buttonStyles = {
  primary:
    "border-emerald-500 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-black",
  ghost:
    "border-white/10 text-gray-400 hover:border-emerald-500/40 hover:text-emerald-400",
  /** Backs out: stays gray. */
  quiet:
    "border-white/10 text-gray-400 hover:border-white/20 hover:bg-white/5 hover:text-gray-200 focus-visible:outline-gray-500",
  /** Starts something that cannot be undone: red only on hover. */
  danger:
    "border-white/10 text-gray-400 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-red-500",
  /** Confirms it. */
  destroy:
    "border-red-500 bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-black focus-visible:outline-red-500",
};

/** The button look, for links that act as buttons. */
export function buttonClass(variant: keyof typeof buttonStyles = "primary") {
  return `inline-flex items-center justify-center gap-2 border px-6 py-2.5 text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:pointer-events-none disabled:opacity-30 ${buttonStyles[variant]}`;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonStyles;
}) {
  return (
    <button
      type="button"
      className={`${buttonClass(variant)} ${className}`}
      {...props}
    />
  );
}

/** The mark on buttons that add something new. */
export function Plus() {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
      className="size-3 shrink-0"
    >
      <path d="M6 1v10M1 6h10" />
    </svg>
  );
}

/** A pushpin: the rule shows on the Overview. */
export function PinIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path d="M5 2h6M6 2v4.5L4 9.5h8l-2-3V2M8 9.5V14" />
    </svg>
  );
}

/** A form field's label, and the field. */
export const labelClass =
  "mb-2 block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";
export const fieldClass =
  "w-full bg-white/4 px-3 py-2.5 text-sm text-white transition-colors placeholder:text-gray-600 hover:bg-white/6 focus:bg-white/6 focus:outline-none";

/** A row of choices on one filled track; the chosen one lit. */
export const track = "flex w-fit bg-white/3 p-1";
export const choice = (active: boolean) =>
  `inline-flex cursor-pointer items-center gap-2 px-4 py-2 text-xs whitespace-nowrap font-bold tracking-wider uppercase transition-colors ${
    active
      ? "bg-emerald-500/10 text-emerald-400"
      : "text-gray-500 hover:text-gray-300"
  }`;

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-bold tracking-[0.2em] text-emerald-400 uppercase">
      {children}
    </p>
  );
}

/** An on/off switch with its label; the label names the current state. */
export function Switch({
  on,
  onChange,
  label,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
      className={`group inline-flex cursor-pointer items-center gap-3 text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:cursor-wait disabled:opacity-60 ${
        on ? "text-emerald-400" : "text-amber-400"
      }`}
    >
      <span
        aria-hidden
        className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          on ? "bg-emerald-500" : "bg-gray-700"
        }`}
      >
        <span
          className={`size-5 rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${
            on ? "translate-x-5" : ""
          }`}
        />
      </span>
      {label}
    </button>
  );
}

/** A panel standing in for a list that has nothing in it yet. */
export function EmptyState({
  title,
  hint,
  compact = false,
  children,
}: {
  title: string;
  hint: string;
  /** Shorter, for a section within a page rather than the whole page. */
  compact?: boolean;
  /** The way to fill it, usually one button. */
  children?: ReactNode;
}) {
  return (
    <div
      className={`bg-white/2 px-6 text-center ${compact ? "py-8" : "py-16"}`}
    >
      <p
        className={`font-display font-bold text-white uppercase ${compact ? "text-lg" : "text-xl"}`}
      >
        {title}
      </p>
      <p className={`mt-2 text-sm text-gray-500 ${compact ? "mb-5" : "mb-6"}`}>
        {hint}
      </p>
      {children}
    </div>
  );
}

/** The four L-shaped marks framing a panel's corners. */
export function CornerBrackets({ tone = "border-emerald-500/60" }) {
  const corner = `absolute size-3 ${tone}`;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className={`${corner} top-0 left-0 border-t-2 border-l-2`} />
      <div className={`${corner} top-0 right-0 border-t-2 border-r-2`} />
      <div className={`${corner} bottom-0 left-0 border-b-2 border-l-2`} />
      <div className={`${corner} right-0 bottom-0 border-r-2 border-b-2`} />
    </div>
  );
}

/** A short label: a fact about something, like where its ABI came from. */
export function Tag({
  children,
  tone = "text-gray-400",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span
      className={`inline-flex items-center bg-white/5 px-2 py-0.5 text-[10px] font-bold tracking-[0.2em] uppercase ${tone}`}
    >
      {children}
    </span>
  );
}
