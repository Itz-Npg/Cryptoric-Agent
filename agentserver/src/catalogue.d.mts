import type { ModelEntry } from './handlers.mjs'

/** Read and normalise a catalogue file. An unreadable file is an empty list. */
export declare function readCatalogueFile(path: string): ModelEntry[]
