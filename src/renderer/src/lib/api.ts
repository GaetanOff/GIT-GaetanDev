import type { GitErrorCode } from '@shared/api'

export const api = window.gdg.invoke
export const on = window.gdg.on

export interface AppError {
  message: string
  code?: GitErrorCode
}

/** Errors thrown across the bridge are plain `{ message, code }` objects. */
export function asError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'message' in e) return e as AppError
  return { message: String(e) }
}
