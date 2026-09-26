import {
  MAX_KEYSTORE_BYTES,
  MIN_PASSPHRASE,
  type KeyItem,
  type NewKey,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { formatUnits } from "../lib/format";
import { Button, fieldClass, labelClass, Plus, Tag } from "./ui";

const quietLink =
  "cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-200";

type Made = { key: NewKey; imported: boolean };

/** The keys responses are signed with: the engine holds them, this lists and unlocks them. */
export function Keys() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["keys"],
    queryFn: ({ signal }) => api.keys(signal),
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const names = new Map(
    contracts?.map((c) => [c.address.toLowerCase(), c.name]),
  );
  const [adding, setAdding] = useState<"create" | "import" | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["keys"] }),
      queryClient.invalidateQueries({ queryKey: ["engine"] }),
    ]);
  const done = (result: Made) => {
    setAdding(null);
    setMade(result);
    void refresh();
  };

  if (error) {
    return (
      <p className="bg-white/2 px-5 py-4 text-sm text-gray-500">
        The keys cannot be read now: {error.message}
      </p>
    );
  }

  return (
    <div>
      {made && <MadeNotice made={made} onClose={() => setMade(null)} />}

      <ul className="mb-6 space-y-2">
        {data?.keys.length === 0 && !adding && (
          <li className="bg-white/2 px-5 py-4 text-sm text-gray-500">
            No keys yet. A rule that acts on chain sends its transaction from
            one.
          </li>
        )}
        {data?.keys.map((key) => (
          <KeyRow
            key={key.address}
            item={key}
            names={names}
            onChange={() => void refresh()}
          />
        ))}
      </ul>

      {adding === "create" && (
        <CreateKey
          onCancel={() => setAdding(null)}
          onDone={(key) => done({ key, imported: false })}
        />
      )}
      {adding === "import" && (
        <ImportKey
          onCancel={() => setAdding(null)}
          onDone={(key) => done({ key, imported: true })}
        />
      )}
      {!adding && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              setMade(null);
              setAdding("create");
            }}
          >
            <Plus />
            Create key
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setMade(null);
              setAdding("import");
            }}
          >
            <Plus />
            Import keystore
          </Button>
        </div>
      )}

      {data && (
        <p
          className="mt-6 text-xs text-gray-500"
          title="There is no delete or export here. The file is the key: back it up by copying it; remove a key by deleting its file while Tripwire is stopped."
        >
          {data.directory ? (
            <>
              Keystore files are in{" "}
              <span className="font-mono wrap-anywhere text-gray-400">
                {data.directory}
              </span>
              .
            </>
          ) : (
            "The stand-in keeps its keys in its database: for trying Tripwire out, not for funds."
          )}
        </p>
      )}
    </div>
  );
}

function KeyRow({
  item,
  names,
  onChange,
}: {
  item: KeyItem;
  names: Map<string, string>;
  onChange: () => void;
}) {
  const [unlocking, setUnlocking] = useState(false);
  const lock = useMutation({
    mutationFn: () => api.lockKey(item.address),
    onSuccess: onChange,
  });
  const broke = item.balanceWei === "0";

  return (
    <li className="bg-white/3">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 ${item.unlocked ? "bg-emerald-400" : "bg-gray-600"}`}
          />
          <span
            className="font-mono text-xs wrap-anywhere text-white"
            title={item.file ?? undefined}
          >
            {item.address}
          </span>
          {item.signing && (
            <Tag tone="text-emerald-400">
              <span title="Responses are sent from this key">Signing</span>
            </Tag>
          )}
          <span
            className={`font-mono text-xs ${broke ? "text-red-400" : "text-gray-400"}`}
            title={
              broke
                ? "No funds for gas: this key cannot send a response"
                : "Balance at the current block"
            }
          >
            {formatUnits(item.balanceWei, 18)} ETH
          </span>
          {item.operatorOn.length > 0 && (
            <span
              className="text-xs text-gray-500"
              title="The controller lets it pause these"
            >
              Operator on{" "}
              {item.operatorOn
                .map((a) => names.get(a.toLowerCase()) ?? a)
                .join(", ")}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-gray-500">
            {item.unlocked ? "Unlocked" : "Locked"}
          </span>
          {item.unlocked ? (
            <button
              type="button"
              className={quietLink}
              disabled={lock.isPending}
              title="It stops signing at once; responses wait until it is unlocked"
              onClick={() => lock.mutate()}
            >
              Lock
            </button>
          ) : (
            !unlocking && (
              <Button variant="ghost" onClick={() => setUnlocking(true)}>
                Unlock
              </Button>
            )
          )}
        </span>
      </div>
      {lock.error && (
        <p className="px-5 pb-3 text-xs text-red-400">{lock.error.message}</p>
      )}
      {unlocking && !item.unlocked && (
        <Unlock
          address={item.address}
          onCancel={() => setUnlocking(false)}
          onDone={() => {
            setUnlocking(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

function Unlock({
  address,
  onCancel,
  onDone,
}: {
  address: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const unlock = useMutation({
    mutationFn: () => api.unlockKey(address, passphrase),
    onSuccess: onDone,
    onSettled: () => setPassphrase(""),
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3 px-5 pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        unlock.mutate();
      }}
    >
      <label className="min-w-64 flex-1">
        <span className={labelClass}>Passphrase</span>
        <input
          className={fieldClass}
          type="password"
          autoComplete="off"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          required
        />
      </label>
      <Button type="submit" disabled={unlock.isPending || !passphrase}>
        {unlock.isPending ? "Unlocking…" : "Unlock"}
      </Button>
      <Button variant="quiet" onClick={onCancel}>
        Cancel
      </Button>
      {unlock.error && (
        <p className="w-full text-xs text-red-400">{unlock.error.message}</p>
      )}
    </form>
  );
}

function CreateKey({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (key: NewKey) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const create = useMutation({
    mutationFn: () => api.createKey(passphrase),
    onSuccess: onDone,
  });
  const short = passphrase.length < MIN_PASSPHRASE;
  const differs = again !== "" && again !== passphrase;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!short && again === passphrase) create.mutate();
  };

  return (
    <form className="space-y-5 bg-white/3 px-5 py-5" onSubmit={submit}>
      <p className="text-sm text-gray-400">
        The engine makes the key and keeps it encrypted with this passphrase.
        Nobody can recover a passphrase that is lost.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Passphrase</span>
          <input
            className={fieldClass}
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={`${MIN_PASSPHRASE} characters or more`}
            required
          />
        </label>
        <label>
          <span className={labelClass}>Again</span>
          <input
            className={fieldClass}
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            required
          />
        </label>
      </div>
      {differs && <p className="text-xs text-red-400">The two do not match.</p>}
      {create.error && (
        <p className="text-xs text-red-400">{create.error.message}</p>
      )}
      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={create.isPending || short || again !== passphrase}
        >
          {create.isPending ? "Creating…" : "Create key"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ImportKey({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (key: NewKey) => void;
}) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const load = useMutation({
    mutationFn: () => api.importKey(file!.text, passphrase),
    onSuccess: onDone,
  });

  return (
    <form
      className="space-y-5 bg-white/3 px-5 py-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (file) load.mutate();
      }}
    >
      <p className="text-sm text-gray-400">
        A keystore file from another wallet or tool. The engine checks the
        passphrase opens it before keeping it; it arrives locked.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className={labelClass}>Keystore file</span>
          <input
            className={`${fieldClass} cursor-pointer file:mr-3 file:cursor-pointer file:border-0 file:bg-white/5 file:px-3 file:py-1 file:text-xs file:text-gray-300`}
            // Keystores are often named without an extension, as geth writes them.
            type="file"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              setFile(null);
              setProblem(null);
              if (!chosen) return;
              if (chosen.size > MAX_KEYSTORE_BYTES) {
                setProblem("That file is over 64 KB: not a keystore.");
                return;
              }
              void chosen
                .text()
                .then((text) => setFile({ name: chosen.name, text }));
            }}
            required
          />
        </label>
        <label>
          <span className={labelClass}>Its passphrase</span>
          <input
            className={fieldClass}
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
        </label>
      </div>
      {(problem ?? load.error) && (
        <p className="text-xs text-red-400">{problem ?? load.error?.message}</p>
      )}
      <div className="flex gap-3">
        <Button type="submit" disabled={load.isPending || !file || !passphrase}>
          {load.isPending ? "Checking…" : "Import"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function MadeNotice({ made, onClose }: { made: Made; onClose: () => void }) {
  return (
    <div className="mb-6 space-y-3 bg-emerald-500/6 px-5 py-5">
      <p className="text-sm text-emerald-300">
        {made.imported
          ? "Imported, and locked: unlock it to sign with it."
          : "Created, and unlocked until the engine restarts."}
      </p>
      <p className="font-mono text-xs wrap-anywhere text-emerald-300">
        {made.key.address}
      </p>
      {made.key.file && (
        <p className="text-xs text-gray-400">
          Its file is{" "}
          <span className="font-mono wrap-anywhere text-gray-300">
            {made.key.file}
          </span>
          . Copy it somewhere safe: the file is the key, and the passphrase
          cannot be recovered.
        </p>
      )}
      <Button variant="ghost" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}
