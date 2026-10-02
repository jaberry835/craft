import { describe, expect, it } from "vitest";
import { pageSlice } from "../src/pagination.js";

describe("local pagination", () => {
  it("returns deterministic pages", () => {
    const first = pageSlice([1, 2, 3, 4, 5], 2, undefined, { exposure: "public" });
    const second = pageSlice(
      [1, 2, 3, 4, 5],
      2,
      first.nextPageToken ?? undefined,
      { exposure: "public" }
    );

    expect(first.values).toEqual([1, 2]);
    expect(second.values).toEqual([3, 4]);
    expect(second.nextPageToken).not.toBeNull();
  });

  it("rejects a token when filters change", () => {
    const first = pageSlice([1, 2, 3], 1, undefined, { exposure: "public" });

    expect(() =>
      pageSlice(
        [1, 2, 3],
        1,
        first.nextPageToken ?? undefined,
        { exposure: "private" }
      )
    ).toThrow("does not match");
  });

  it("rejects malformed tokens", () => {
    expect(() => pageSlice([1, 2], 1, "not-base64-json", {})).toThrow(
      "Invalid page token"
    );
  });
});
