import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (name: string) => lookup(name),
}));

const { controllerHost } = await import("./controller-host");

beforeEach(() => lookup.mockReset());

describe("controllerHost", () => {
  it("links by address, because Vite refuses an unknown hostname", async () => {
    lookup.mockResolvedValueOnce({ address: "10.0.3.50", family: 4 });

    expect(await controllerHost("https://one.lan")).toBe("10.0.3.50");
    expect(lookup).toHaveBeenCalledWith("one.lan");
  });

  it("resolves once and then answers from the cache", async () => {
    lookup.mockResolvedValue({ address: "10.0.3.51", family: 4 });

    await controllerHost("https://two.lan");
    await controllerHost("https://two.lan");

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup, so the next read tries again", async () => {
    // Caching the fallback would link every forward by name until a restart, and Vite 403s
    // every one of them.
    lookup.mockRejectedValueOnce(new Error("EAI_AGAIN"));
    lookup.mockResolvedValueOnce({ address: "10.0.3.52", family: 4 });

    expect(await controllerHost("https://three.lan")).toBe("three.lan");
    expect(await controllerHost("https://three.lan")).toBe("10.0.3.52");
  });
});
