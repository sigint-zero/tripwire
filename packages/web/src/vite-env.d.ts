/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Development only: `<chainId>:<address>` to prefill a new invariant. */
  readonly VITE_DEV_CONTRACT?: string;
}
