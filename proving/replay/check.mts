/**
 * Rig E's hard limit on the npm engine's check against a release.
 *
 * The engine checks in process and stops at a deadline only where the type
 * checker offers to; decipad's files against stripe-node 17 sat in one call
 * for hours. So the replay runs each check here, in a worker it ends at the
 * deadline whatever the checker is doing, and the files the check did not
 * reach are listed as unchecked. The engine itself starts no thread.
 */
import { parentPort, Worker, workerData } from "node:worker_threads";
import {
  type Checker,
  type CheckRequest,
  diagnosticsIn,
  type Found,
} from "@invariant-app/migrate-ts";

/** Each check in a worker of its own, ended at the request's deadline. */
export const workerChecker: Checker = async (request) => {
  const worker = new Worker(new URL(import.meta.url), { workerData: request });
  try {
    return await new Promise<Map<string, Found[]> | undefined>((resolve, reject) => {
      const timer =
        request.deadline === undefined
          ? undefined
          : setTimeout(
              () => resolve(undefined),
              Math.max(0, request.deadline - Date.now()),
            );
      worker.once("message", (found: (readonly [string, Found[]])[]) => {
        clearTimeout(timer);
        resolve(new Map(found));
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
};

if (parentPort && workerData) {
  parentPort.postMessage([...diagnosticsIn(workerData as CheckRequest)]);
}
