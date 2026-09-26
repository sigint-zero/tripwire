import type { ButtonHTMLAttributes, ReactNode } from "react";

const buttonStyles = {
  primary:
    "border-emerald-500 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-black",
  ghost:
    "border-white/10 text-gray-400 hover:border-emerald-500/40 hover:text-emerald-400",
};

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
      className={`inline-flex items-center justify-center gap-2 border px-6 py-2.5 text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:pointer-events-none disabled:opacity-30 ${buttonStyles[variant]} ${className}`}
      {...props}
    />
  );
}

export function Eyebrow({
  children,
  dot = "bg-emerald-500",
}: {
  children: ReactNode;
  dot?: string;
}) {
  return (
    <p className="flex items-center gap-2 text-xs font-bold tracking-[0.2em] text-emerald-400 uppercase">
      <span className={`size-2 ${dot}`} />
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
