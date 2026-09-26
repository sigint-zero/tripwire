import { useState } from "react";

/** One labelled value with a copy button: an address, calldata. */
export function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-start gap-3 py-1">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="font-mono text-xs break-all text-gray-200">{value}</span>
      <button
        type="button"
        className="cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
