export interface Chain {
  id: number;
  name: string;
  /** The native currency's symbol: what gas is paid in. */
  currency: string;
  /** The block explorer's base URL. */
  explorer: string;
}

export const chains: readonly Chain[] = [
  {
    id: 1,
    name: "Ethereum",
    currency: "ETH",
    explorer: "https://etherscan.io",
  },
  { id: 8453, name: "Base", currency: "ETH", explorer: "https://basescan.org" },
  {
    id: 42161,
    name: "Arbitrum One",
    currency: "ETH",
    explorer: "https://arbiscan.io",
  },
  {
    id: 10,
    name: "OP Mainnet",
    currency: "ETH",
    explorer: "https://optimistic.etherscan.io",
  },
  {
    id: 137,
    name: "Polygon",
    currency: "POL",
    explorer: "https://polygonscan.com",
  },
  {
    id: 11155111,
    name: "Sepolia",
    currency: "ETH",
    explorer: "https://sepolia.etherscan.io",
  },
  {
    id: 84532,
    name: "Base Sepolia",
    currency: "ETH",
    explorer: "https://sepolia.basescan.org",
  },
];

export function chainName(id: number): string {
  return chains.find((chain) => chain.id === id)?.name ?? `Chain ${id}`;
}

/** The symbol gas is paid in on the chain; ETH for one not listed. */
export function chainCurrency(id: number): string {
  return chains.find((chain) => chain.id === id)?.currency ?? "ETH";
}

/** An address or a transaction on the chain's block explorer; null for a chain without a known one. */
export function explorerUrl(
  chainId: number,
  kind: "address" | "tx",
  value: string,
): string | null {
  const chain = chains.find((c) => c.id === chainId);
  return chain ? `${chain.explorer}/${kind}/${value}` : null;
}
