export interface Chain {
  id: number;
  name: string;
}

export const chains: readonly Chain[] = [
  { id: 1, name: "Ethereum" },
  { id: 8453, name: "Base" },
  { id: 42161, name: "Arbitrum One" },
  { id: 10, name: "OP Mainnet" },
  { id: 137, name: "Polygon" },
  { id: 11155111, name: "Sepolia" },
  { id: 84532, name: "Base Sepolia" },
];

export function chainName(id: number): string {
  return chains.find((chain) => chain.id === id)?.name ?? `Chain ${id}`;
}
