/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Development only: a contract address to prefill a new rule. */
  readonly VITE_DEV_CONTRACT?: string;
}
