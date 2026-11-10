/**
 * Start tasks in order, at most `limit` at a time, and return one promise per task (same order).
 * Used to download flipbook pages ahead while earlier ones are being drawn/encoded: fetching them
 * one by one made a 48-page GIF wait ~20 s on the network alone.
 */
export function prefetch<T>(tasks: (() => Promise<T>)[], limit = 6): Promise<T>[] {
  const slots = tasks.map(() => {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => {}) // a page nobody awaits (job stopped early) must not log an unhandled rejection
    return { promise, resolve, reject }
  })
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      try {
        slots[i].resolve(await tasks[i]())
      } catch (e) {
        slots[i].reject(e)
      }
    }
  }
  for (let k = 0; k < Math.min(limit, tasks.length); k++) void worker()
  return slots.map((s) => s.promise)
}
