import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("./platform", () => ({
  invoke: invokeMock,
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getRealizedPnl } from "./portfolio";

describe("getRealizedPnl", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("invokes get_realized_pnl with the provided filter", async () => {
    const response = { baseCurrency: "USD", entries: [], total: { base: 0 } };
    invokeMock.mockResolvedValue(response);

    const result = await getRealizedPnl({ type: "account", accountId: "acc_1" });

    expect(invokeMock).toHaveBeenCalledWith("get_realized_pnl", {
      filter: { type: "account", accountId: "acc_1" },
    });
    expect(result).toBe(response);
  });

  it("invokes with undefined filter when none is given", async () => {
    invokeMock.mockResolvedValue({ baseCurrency: "USD", entries: [], total: { base: 0 } });

    await getRealizedPnl();

    expect(invokeMock).toHaveBeenCalledWith("get_realized_pnl", { filter: undefined });
  });
});
