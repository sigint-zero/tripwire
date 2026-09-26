import type { ButtonHTMLAttributes, ReactNode } from "react";

const buttonStyles = {
  primary:
    "border-emerald-500 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-black",
  ghost:
    "border-white/10 text-gray-400 hover:border-emerald-500/40 hover:text-emerald-400",
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

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-bold tracking-[0.2em] text-emerald-400 uppercase">
      {children}
    </p>
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
