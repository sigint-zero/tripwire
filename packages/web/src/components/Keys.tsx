import {
  chainCurrency,
  explorerUrl,
  MAX_KEY_NAME,
  MAX_KEYSTORE_BYTES,
  MIN_PASSPHRASE,
  type KeyDetail,
  type KeyItem,
  type KeyPower,
  type KeyTransaction,
  type NewKey,
  type ResponseStatus,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { formatBig, formatUnits, shortAddress, timeAgo } from "../lib/format";
import { responseStatuses } from "../lib/responses";
import { Copyable } from "./Copyable";
import { Button, fieldClass, labelClass, Plus, Tag } from "./ui";

const quietLink =
  "cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-200";

type Made = { key: NewKey; imported: boolean };

/** The chain the engine watches, once known. */
function useChainId(): number | undefined {
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  return engine?.chainId;
}

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
  // The key whose passphrase is being asked for, if any.
  const [unlockingKey, setUnlockingKey] = useState<string | null>(null);
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
      {made && (
        <MadeNotice
          made={made}
          onClose={() => setMade(null)}
          onUnlock={() => {
            setUnlockingKey(made.key.address);
            setMade(null);
          }}
        />
      )}

      {data && data.keys.length > 1 && !data.keys.some((k) => k.signing) && (
        // Only files put there by hand get here: the dashboard adds one key.
        <p className="mb-4 bg-red-500/10 px-5 py-4 text-sm text-red-300">
          With {data.keys.length} keys and none named to sign, the engine does
          not know which one signs, so responses wait. Keep one key: remove the
          others' files while Tripwire is stopped.
        </p>
      )}

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
            unlocking={unlockingKey === key.address}
            onUnlocking={(open) => setUnlockingKey(open ? key.address : null)}
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
      {data && data.keys.length > 0 && (
        <p className="text-xs text-gray-500">
          Tripwire signs with one key for now, so there is no adding another.
        </p>
      )}
      {data?.keys.length === 0 && !adding && (
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
  unlocking,
  onUnlocking: setUnlocking,
  onChange,
}: {
  item: KeyItem;
  names: Map<string, string>;
  unlocking: boolean;
  onUnlocking: (open: boolean) => void;
  onChange: () => void;
}) {
  const lock = useMutation({
    mutationFn: () => api.lockKey(item.address),
    onSuccess: onChange,
  });
  const [open, setOpen] = useState(false);
  const chainId = useChainId();
  const broke = item.balanceWei === "0";
  // Rules would sign with it, and it cannot sign.
  const blocking = !item.unlocked && item.neededBy > 0;

  return (
    <li className={blocking ? "bg-red-500/8" : "bg-white/3"}>
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 ${item.unlocked ? "bg-emerald-400" : blocking ? "bg-red-400" : "bg-gray-600"}`}
          />
          {item.name && <span className="text-white">{item.name}</span>}
          <span
            className={`font-mono text-xs wrap-anywhere ${item.name ? "text-gray-400" : "text-white"}`}
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
            {formatUnits(item.balanceWei, 18)} {chainCurrency(chainId ?? 1)}
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
          <button
            type="button"
            className={quietLink}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide details" : "Details"}
          </button>
          <span
            className={`text-xs ${blocking ? "font-bold text-red-400" : "text-gray-500"}`}
          >
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
      {blocking && (
        <p className="px-5 pb-3.5 text-sm text-red-300">
          {neededSentence(item.neededBy)} Unlock it to let them respond.
        </p>
      )}
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
      {open && <KeyDetails address={item.address} onChange={onChange} />}
    </li>
  );
}

/** "2 rules that act on chain sign with this key, and it is locked." */
export function neededSentence(rules: number): string {
  return `${rules === 1 ? "1 rule that acts" : `${rules} rules that act`} on chain ${rules === 1 ? "signs" : "sign"} with this key, and it is locked.`;
}

/** One key opened up: its name, where it lives, what it may do, and what it has sent. */
function KeyDetails({
  address,
  onChange,
}: {
  address: string;
  onChange: () => void;
}) {
  const { data, error } = useQuery({
    queryKey: ["keys", address],
    queryFn: ({ signal }) => api.key(address, signal),
  });
  const chainId = useChainId();

  if (error) {
    return (
      <p className="border-t border-white/5 px-5 py-4 text-sm text-gray-500">
        This key's details cannot be read now: {error.message}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="border-t border-white/5 px-5 py-4 text-sm text-gray-500">
        Reading…
      </p>
    );
  }
  const onExplorer =
    chainId === undefined ? null : explorerUrl(chainId, "address", address);

  return (
    <div className="space-y-6 border-t border-white/5 px-5 py-5">
      <KeyName address={address} name={data.key.name} onChange={onChange} />

      <div>
        <Copyable label="Address" value={address} />
        {data.key.file && <Copyable label="File" value={data.key.file} />}
        <p className="mt-2 text-xs text-gray-500">
          Fund it by sending {chainCurrency(chainId ?? 1)} to this address:
          every transaction it sends pays gas.
          {onExplorer && (
            <>
              {" "}
              <a
                className="text-gray-300 underline decoration-white/20 underline-offset-2 hover:text-white"
                href={onExplorer}
                target="_blank"
                rel="noreferrer"
              >
                Open on the explorer
              </a>
            </>
          )}
        </p>
      </div>

      <section>
        <h3 className={labelClass}>What it may do</h3>
        <Powers detail={data} />
      </section>

      <section>
        <h3 className={labelClass}>Sent from it</h3>
        <Transactions detail={data} chainId={chainId} />
      </section>
    </div>
  );
}

function KeyName({
  address,
  name,
  onChange,
}: {
  address: string;
  name: string | null;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState(name ?? "");
  const save = useMutation({
    mutationFn: () => api.nameKey(address, draft.trim()),
    onSuccess: onChange,
  });
  const unchanged = draft.trim() === (name ?? "");
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!unchanged) save.mutate();
      }}
    >
      <label className="min-w-64 flex-1">
        <span className={labelClass}>Name</span>
        <input
          className={fieldClass}
          value={draft}
          maxLength={MAX_KEY_NAME}
          placeholder="What it is for: Pauser, Hot wallet"
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <Button
        type="submit"
        variant="ghost"
        disabled={save.isPending || unchanged}
      >
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      {save.error && (
        <p className="w-full text-xs text-red-400">{save.error.message}</p>
      )}
    </form>
  );
}

const powerWords: Record<
  KeyPower["power"],
  { label: string; tone: string; hint: string }
> = {
  owner: {
    label: "Owner of",
    tone: "text-amber-300",
    hint: "It could also upgrade the contract, change its settings or move funds. Grant it only the right to pause.",
  },
  admin: {
    label: "Admin on",
    tone: "text-amber-300",
    hint: "It could grant itself any role. Grant it only the right to pause.",
  },
  operator: {
    label: "Operator on",
    tone: "text-emerald-400",
    hint: "The controller lets it pause this contract, and nothing more.",
  },
};

function Powers({ detail }: { detail: KeyDetail }) {
  return (
    <div className="mt-2 space-y-2">
      {detail.powers.length === 0 && !detail.powersProblem && (
        <p className="text-sm text-gray-500">
          It is not the owner or an admin of any registered contract, and the
          controller names it an operator on none.
        </p>
      )}
      {detail.powers.length > 0 && (
        <ul className="space-y-1">
          {detail.powers.map((p) => {
            const words = powerWords[p.power];
            return (
              <li
                key={`${p.power}:${p.contract.address}`}
                className="text-sm"
                title={words.hint}
              >
                <span className={words.tone}>{words.label}</span>{" "}
                <Link
                  to="/contracts/$address"
                  params={{ address: p.contract.address }}
                  className="text-gray-200 hover:text-white"
                >
                  {p.contract.name}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {detail.powersProblem && (
        <p className="text-xs text-gray-500">{detail.powersProblem}</p>
      )}
    </div>
  );
}

function Transactions({
  detail,
  chainId,
}: {
  detail: KeyDetail;
  chainId: number | undefined;
}) {
  return (
    <div className="mt-2">
      {detail.transactions.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {detail.transactions.map((tx) => (
            <TransactionRow
              key={`${tx.kind}:${tx.id}`}
              tx={tx}
              chainId={chainId}
            />
          ))}
        </ul>
      )}
      {detail.unattributed > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          {detail.unattributed === 1
            ? "1 more transaction does not name the key that sent it"
            : `${detail.unattributed} more transactions do not name the key that sent them`}
          , and with several keys Tripwire cannot tell which one did.
        </p>
      )}
    </div>
  );
}

function TransactionRow({
  tx,
  chainId,
}: {
  tx: KeyTransaction;
  chainId: number | undefined;
}) {
  const status = responseStatuses[tx.status as ResponseStatus] ?? {
    label: tx.status,
    tone: "text-gray-400",
  };
  const onExplorer =
    chainId === undefined ? null : explorerUrl(chainId, "tx", tx.hash);
  return (
    <li className="grid gap-1 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
      <span className="min-w-0">
        <span className="font-mono text-xs text-gray-200">{tx.call}</span>{" "}
        <span className="text-gray-500">on</span>{" "}
        <span className="text-gray-300">
          {tx.contract.name ?? shortAddress(tx.contract.address)}
        </span>
        <span className="block text-xs text-gray-500">
          {tx.kind === "response" ? (
            <Link
              to="/responses"
              search={{ open: tx.id }}
              className="hover:text-gray-300"
            >
              Response to {tx.reason}
            </Link>
          ) : (
            <Link
              to="/contracts/$address"
              params={{ address: tx.contract.address }}
              className="hover:text-gray-300"
            >
              By hand{tx.reason ? `: ${tx.reason}` : ""}
            </Link>
          )}{" "}
          · {timeAgo(tx.createdAt)}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:justify-end">
        <span className={status.tone}>{status.label}</span>
        {tx.gasUsed && (
          <span className="text-gray-500">{formatBig(tx.gasUsed)} gas</span>
        )}
        {onExplorer ? (
          <a
            className="font-mono text-gray-400 hover:text-white"
            href={onExplorer}
            target="_blank"
            rel="noreferrer"
            title={tx.hash}
          >
            {shortAddress(tx.hash)}
          </a>
        ) : (
          <span className="font-mono text-gray-400" title={tx.hash}>
            {shortAddress(tx.hash)}
          </span>
        )}
      </span>
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

function MadeNotice({
  made,
  onClose,
  onUnlock,
}: {
  made: Made;
  onClose: () => void;
  onUnlock: () => void;
}) {
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
      <div className="flex gap-3">
        {made.imported && <Button onClick={onUnlock}>Unlock it</Button>}
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
