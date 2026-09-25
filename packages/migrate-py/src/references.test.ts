import { describe, expect, it } from "vitest";
import { importedFor } from "./references.ts";

describe("importedFor", () => {
  it("imports a type's whole module path, so a nested package resolves", () => {
    expect(importedFor("anthropic.types.beta.BetaMessage")).toBe("anthropic.types.beta");
    expect(importedFor("openai.types.chat.ChatCompletion")).toBe("openai.types.chat");
  });

  it("stops at the first class, so a nested class imports its package", () => {
    expect(importedFor("stripe.Subscription.AutomaticTax")).toBe("stripe");
    expect(importedFor("stripe.Subscription")).toBe("stripe");
  });

  it("imports the name itself when nothing in it is a class", () => {
    expect(importedFor("stripe")).toBe("stripe");
  });
});
