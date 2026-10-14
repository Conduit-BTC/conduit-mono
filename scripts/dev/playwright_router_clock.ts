import { randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const format = "conduit-router-clock-v1"
const maxOffsetMs = 24 * 60 * 60 * 1_000
const renameRetryWait = new Int32Array(new SharedArrayBuffer(4))
type Environment = Record<string, string | undefined>

function unavailable(): never {
  throw new Error("Isolated router clock unavailable.")
}

function validateFile(filePath: string | undefined): string {
  try {
    if (!filePath || !path.isAbsolute(filePath)) unavailable()
    const resolved = path.resolve(filePath)
    const directory = path.dirname(resolved)
    if (
      resolved !== filePath ||
      path.basename(resolved) !== "clock.json" ||
      path.dirname(directory) !== realpathSync(tmpdir()) ||
      !/^conduit-router-clock-[A-Za-z0-9]+$/.test(path.basename(directory)) ||
      lstatSync(directory).isSymbolicLink() ||
      !lstatSync(directory).isDirectory() ||
      lstatSync(resolved).isSymbolicLink() ||
      !lstatSync(resolved).isFile()
    ) {
      unavailable()
    }
    return resolved
  } catch {
    unavailable()
  }
}

function readOffset(filePath: string): number {
  try {
    const record: unknown = JSON.parse(
      readFileSync(validateFile(filePath), "utf8")
    )
    if (
      !record ||
      typeof record !== "object" ||
      Object.keys(record).length !== 2 ||
      !("format" in record) ||
      record.format !== format ||
      !("offsetMs" in record) ||
      typeof record.offsetMs !== "number" ||
      !Number.isSafeInteger(record.offsetMs) ||
      record.offsetMs < 0 ||
      record.offsetMs > maxOffsetMs
    ) {
      unavailable()
    }
    return record.offsetMs
  } catch {
    unavailable()
  }
}

function writeOffset(filePath: string, offsetMs: number): void {
  // Same-directory replacement keeps synchronous relay reads from seeing a
  // partially written record. Only the serial Playwright worker advances time.
  const pending = `${filePath}.${randomUUID()}.next`
  try {
    writeFileSync(pending, JSON.stringify({ format, offsetMs }), {
      flag: "wx",
      mode: 0o600,
    })
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(pending, filePath)
        break
      } catch (error) {
        // On Windows a concurrent readFileSync can briefly deny replacement.
        // Retain the exact pending record, retry only that sharing failure,
        // and still fail closed if the bounded replacement cannot complete.
        if (
          process.platform !== "win32" ||
          (error as { code?: string }).code !== "EPERM" ||
          attempt >= 24
        ) {
          throw error
        }
        Atomics.wait(renameRetryWait, 0, 0, 2)
      }
    }
  } catch {
    unavailable()
  } finally {
    if (existsSync(pending)) unlinkSync(pending)
  }
}

export interface PlaywrightRouterClock {
  nowMs(): number
  /** Advances Date only; callers synchronize each live browser clock. */
  advanceBy(milliseconds: number): number
  /** Call between sequential tests, after closing the previous contexts. */
  reset(): number
}

/** Runner-only file seam. Never import this module into an app/browser bundle. */
export function openPlaywrightRouterClock(
  environment: Environment = process.env
): PlaywrightRouterClock {
  const filePath = validateFile(environment.PLAYWRIGHT_ROUTER_CLOCK_FILE)
  readOffset(filePath)
  const nowMs = () => Date.now() + readOffset(filePath)
  return {
    nowMs,
    advanceBy(milliseconds) {
      const current = readOffset(filePath)
      if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 0 ||
        milliseconds > maxOffsetMs - current
      ) {
        unavailable()
      }
      writeOffset(filePath, current + milliseconds)
      return nowMs()
    },
    reset() {
      readOffset(filePath)
      writeOffset(filePath, 0)
      return nowMs()
    },
  }
}

/** Deletes only the validated clock file and its now-empty owned directory. */
export function cleanupPlaywrightRouterClock(environment: Environment): void {
  const candidate = environment.PLAYWRIGHT_ROUTER_CLOCK_FILE
  if (
    candidate &&
    !existsSync(candidate) &&
    !existsSync(path.dirname(candidate))
  )
    return
  const filePath = validateFile(candidate)
  readOffset(filePath)
  unlinkSync(filePath)
  rmdirSync(path.dirname(filePath))
}

/** Only the dedicated router relay launcher creates a fresh clock per run. */
export function createPlaywrightRouterClock(): PlaywrightRouterClock & {
  filePath: string
  cleanup(): void
} {
  const directory = mkdtempSync(
    path.join(realpathSync(tmpdir()), "conduit-router-clock-")
  )
  const filePath = path.join(directory, "clock.json")
  writeOffset(filePath, 0)
  const environment = { PLAYWRIGHT_ROUTER_CLOCK_FILE: filePath }
  return {
    ...openPlaywrightRouterClock(environment),
    filePath,
    cleanup: () => cleanupPlaywrightRouterClock(environment),
  }
}
