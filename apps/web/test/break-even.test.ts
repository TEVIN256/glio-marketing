import { describe, expect, it } from "vitest";
import { breakEvenRoas, marginToBasisPoints, profitAfterAds, standing } from "@/lib/break-even";

describe("break-even ROAS (ADR-035)", () => {
  it("reads margins as typed (40, 37.5, 40%, Arabic decimal comma) and refuses nonsense", () => {
    expect(marginToBasisPoints("40")).toBe(4000);
    expect(marginToBasisPoints("37.5")).toBe(3750);
    expect(marginToBasisPoints("40%")).toBe(4000);
    expect(marginToBasisPoints("37٫5")).toBe(3750);
    expect(marginToBasisPoints("40.00")).toBe(4000);
    for (const bad of ["0", "101", "-5", "abc", "", "12.345", null]) expect(marginToBasisPoints(bad)).toBeNull();
  });

  it("break-even = 100 / margin, rounded half-up to 2 decimals", () => {
    expect(breakEvenRoas(4000)).toBe("2.50");
    expect(breakEvenRoas(3000)).toBe("3.33");
    expect(breakEvenRoas(10_000)).toBe("1.00");
    expect(breakEvenRoas(1)).toBe("10000.00");
  });

  it("compares exactly, without rounding ROAS first", () => {
    // 40% margin: break-even exactly at value = 2.5 × spend.
    expect(standing(25_000n, 10_000n, 4000)).toBe("at");
    expect(standing(25_001n, 10_000n, 4000)).toBe("above");
    expect(standing(24_999n, 10_000n, 4000)).toBe("below");
    expect(standing(100n, 0n, 4000)).toBeNull();
  });

  it("estimated gross profit after ad spend = value × margin − spend (WAKE UP-like numbers)", () => {
    // SAR 347,167.77 purchase value, SAR 30,352.41 spend, 40% margin → SAR 108,514.70
    expect(profitAfterAds(34_716_777n, 3_035_241n, 4000)).toBe(10_851_470n);
    expect(profitAfterAds(10_000n, 5_000n, 4000)).toBe(-1_000n); // ROAS 2.0 at 40% margin loses money
  });
});
