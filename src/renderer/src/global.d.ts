import type { CryptoricApi } from '../../preload'

declare global {
  interface Window {
    /** The only bridge between the renderer and the main process. */
    cryptoric: CryptoricApi
  }
}

export {}