import type { Api, ApiEvents } from '../shared/api'

declare global {
  interface Window {
    gdg: {
      invoke: Api
      on<K extends keyof ApiEvents>(channel: K, fn: (payload: ApiEvents[K]) => void): () => void
      pathForFile(file: File): string
    }
  }
}

export {}
