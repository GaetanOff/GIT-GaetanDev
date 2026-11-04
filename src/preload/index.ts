import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_CHANNELS, API_EVENTS, type Api, type ApiEvents, type IpcEnvelope } from '@shared/api'

const invoke = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const channel of API_CHANNELS) {
  invoke[channel] = async (...args: unknown[]) => {
    const r = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope<unknown>
    if (r.ok) return r.value
    // Plain objects cross the context bridge; the renderer rebuilds the Error.
    throw { message: r.error?.message ?? 'Unknown error', code: r.error?.code, details: r.error?.details }
  }
}

const bridge = {
  invoke: invoke as unknown as Api,
  on<K extends keyof ApiEvents>(channel: K, fn: (payload: ApiEvents[K]) => void): () => void {
    // The app's events only: a compromised page must not listen on any other channel of the process.
    if (!(API_EVENTS as readonly string[]).includes(channel)) throw new Error(`"${String(channel)}" is not an event of the app.`)
    const listener = (_e: unknown, payload: ApiEvents[K]) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  /** Absolute path of a file dropped on the window. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
}

export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('gdg', bridge)
