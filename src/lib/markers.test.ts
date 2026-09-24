import { describe, expect, it } from "vitest";
import { stripMarkers } from "./markers";

describe("stripMarkers", () => {
  it("hides single, adjacent and grouped markers", () => {
    expect(stripMarkers("Free over 50 [S1].")).toBe("Free over 50.");
    expect(stripMarkers("Free over 50 [S1][S2].")).toBe("Free over 50.");
    expect(stripMarkers("US only [S1, S2] and 30 days [S3,S4].")).toBe("US only and 30 days.");
  });
  it("leaves ordinary brackets alone", () => {
    expect(stripMarkers("Use [brackets] and (S1) freely.")).toBe("Use [brackets] and (S1) freely.");
  });
});
