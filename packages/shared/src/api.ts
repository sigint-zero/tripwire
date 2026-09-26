// Shapes the local API returns, shared by the server and the dashboard.

/** A verified contract's ABI. For a proxy, the implementation's ABI is merged in. */
export interface ContractAbi {
  chainId: number;
  address: string;
  name: string | null;
  abi: unknown[];
  implementation: { address: string; name: string | null } | null;
}

/** A dry run of a rule against current values. */
export interface RulePreview {
  holds: boolean;
  /** The values the condition compares, in order, as decimal strings. */
  terms: { label: string; value: string }[];
  /** One line on how close the rule is to breaking. */
  detail: string;
  /** True while values come from the development stand-in, not the chain. */
  simulated: boolean;
}
