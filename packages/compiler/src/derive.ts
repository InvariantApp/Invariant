/**
 * What a Change costs, derived from its ops rather than declared by its author.
 *
 * Two questions get answered here and nowhere else. Can the old contract still
 * be served exactly, and can a consumer's source be migrated without a person
 * reading it? Both are properties of the op catalog, so both are computable,
 * and computing them keeps a provider from labelling a lossy change as safe.
 *
 * The pointers a round trip cannot preserve come out alongside, because the
 * lens-law check needs to know which fields are allowed to differ before it can
 * insist that everything else matches exactly.
 */
import type { Change, Op, RuntimeClass, SourceClass } from "@invariant/ir";

export interface Derived {
  runtime: RuntimeClass;
  source: SourceClass;
  /** Why it is not `exact`, in a reviewer's words. Empty when it is. */
  reasons: string[];
  /**
   * Pointers whose value a round trip is allowed to alter, by direction.
   *
   * `forward` lists what is lost taking an old value to canonical and back:
   * a field the new contract dropped cannot come back as anything but the
   * declared constant. `backward` lists what is lost taking a canonical value
   * to the old shape and back: a field the old contract never had is replaced
   * by its default, because the old caller had no way to send one.
   */
  lossy: { forward: string[]; backward: string[] };
}

const CLASS_ORDER: Record<RuntimeClass, number> = {
  exact: 0,
  "declared-lossy": 1,
  none: 2,
};

function worse(a: RuntimeClass, b: RuntimeClass): RuntimeClass {
  return CLASS_ORDER[a] >= CLASS_ORDER[b] ? a : b;
}

/**
 * A Change carrying a `behavior` op is not a shape problem at all, and saying
 * so is the honest answer: the provider branches on contract age in their own
 * code, and no transform can stand in for that.
 */
export function derive(change: Change): Derived {
  let runtime: RuntimeClass = "exact";
  let source: SourceClass = "deterministic";
  const reasons: string[] = [];
  const lossy: { forward: string[]; backward: string[] } = {
    forward: [],
    backward: [],
  };

  for (const op of change.ops) {
    switch (op.op) {
      case "move":
      case "route":
        break;
      case "convert":
        if (op.codec.kind === "enumMap") {
          if (op.codec.fold !== undefined && op.codec.fold.length > 0) {
            // The caller is shown a value that is not the one the API meant,
            // and nothing in the response says so. That is the trade this op
            // exists to make, and it has to be visible in the gate.
            runtime = worse(runtime, "declared-lossy");
            source = "assisted";
            reasons.push(
              `the value map at ${op.path} folds ${op.codec.fold.length} new ` +
                `value${op.codec.fold.length === 1 ? "" : "s"} onto values the old ` +
                "contract names, so a caller cannot tell the new case apart",
            );
            lossy.backward.push(op.path);
          }
          const targets = new Set(op.codec.pairs.map(([, to]) => to));
          if (targets.size !== op.codec.pairs.length) {
            runtime = worse(runtime, "declared-lossy");
            source = "assisted";
            reasons.push(
              `the value map at ${op.path} sends two old values to one new one, ` +
                "so the old value cannot be recovered from a response",
            );
            lossy.backward.push(op.path);
          }
        }
        break;
      case "add":
        // Backward drops the field, which is right: the old caller never knew
        // it existed. Forward supplies the declared default, which is a claim
        // about what the API used to do when nobody said otherwise.
        runtime = worse(runtime, "declared-lossy");
        reasons.push(
          `${op.path} is new and required, so every old caller is served with ` +
            `the declared default. That default has to match what the API did ` +
            `before the field existed; nothing in the specification proves it.`,
        );
        lossy.backward.push(op.path);
        break;
      case "remove":
        runtime = worse(runtime, "declared-lossy");
        source = "assisted";
        reasons.push(
          `${op.path} is gone, so a response can only carry the declared ` +
            "constant in its place, not whatever the value used to be",
        );
        lossy.forward.push(op.path);
        break;
      case "default": {
        // Where the API now says nothing, or null, the stricter side is shown
        // the declared value instead. That value is a claim about what the
        // missing field meant, and nothing in the specification proves it.
        runtime = worse(runtime, "declared-lossy");
        const missing =
          op.when === "absent"
            ? "missing"
            : op.when === "null"
              ? "null"
              : "missing or null";
        reasons.push(
          op.toward === "old"
            ? `${op.path} can now be ${missing}, so an old caller is shown the ` +
                "declared default in its place and cannot tell the two apart"
            : `${op.path} can no longer be ${missing}, so the declared default ` +
                "is sent for an old caller who left it that way",
        );
        (op.toward === "old" ? lossy.backward : lossy.forward).push(op.path);
        break;
      }
      case "dropNull":
        // Null and missing are two answers to one question for most callers,
        // and not for all of them, so it is declared.
        runtime = worse(runtime, "declared-lossy");
        reasons.push(
          op.toward === "old"
            ? `${op.path} can now be null, so an old caller is sent the field ` +
                "left out instead"
            : `${op.path} can no longer be null, so a null from an old caller is ` +
                "sent as the field left out",
        );
        (op.toward === "old" ? lossy.backward : lossy.forward).push(op.path);
        break;
      case "widen": {
        // A kind of object the old caller cannot read is shown to them as
        // something they can, and they cannot tell that it was not.
        runtime = worse(runtime, "declared-lossy");
        source = "assisted";
        const variant = op.variant.slice(op.variant.lastIndexOf("/") + 1);
        reasons.push(
          `${op.path} can now hold a ${variant}, which old callers never heard of, ` +
            `so it is shown to them ${op.show === "id" ? "as its id" : op.show === "null" ? "as null" : "left out"} instead`,
        );
        lossy.backward.push(op.path);
        break;
      }
      case "retire":
        runtime = "none";
        source = "manual";
        reasons.push(
          `${op.endpoint.method.toUpperCase()} ${op.endpoint.path} no longer exists, ` +
            "so there is no handler for a rewritten request to reach. The runtime " +
            "refuses it by name rather than returning a bare 404, and nothing else " +
            "can be done for a caller still using it.",
        );
        break;
      case "behavior":
        runtime = "none";
        source = "manual";
        reasons.push(
          `${op.flag} changes behaviour rather than shape, so no transform ` +
            "can serve the old contract. Provider code has to branch on it.",
        );
        break;
    }
  }

  return { runtime, source, reasons, lossy };
}

/** True when the Change needs an acknowledgement it does not carry. */
export function missingAcknowledgement(change: Change, derived: Derived): boolean {
  return (
    derived.runtime === "declared-lossy" && change.assertions?.loss_acknowledged !== true
  );
}

export function isBehaviorOp(op: Op): boolean {
  return op.op === "behavior";
}
