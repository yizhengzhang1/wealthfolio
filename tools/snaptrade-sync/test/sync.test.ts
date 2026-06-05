import { describe, it, expect } from "vitest";
import { selectAccount, type SnapAccount } from "../src/sync.js";

const accounts: SnapAccount[] = [
  { id: "a1", name: "Individual ...613", institution_name: "Schwab" },
  { id: "a2", name: "RRSP", institution_name: "Questrade" },
];

describe("selectAccount", () => {
  it("matches by institution substring (case-insensitive)", () => {
    expect(selectAccount(accounts, "schwab")?.id).toBe("a1");
  });
  it("explicit id wins over institution", () => {
    expect(selectAccount(accounts, "Schwab", "a2")?.id).toBe("a2");
  });
  it("returns null when no institution matches (no silent fallback to accounts[0])", () => {
    expect(selectAccount(accounts, "Fidelity")).toBeNull();
  });
  it("returns null when explicit id is not found", () => {
    expect(selectAccount(accounts, "Schwab", "nope")).toBeNull();
  });
});
