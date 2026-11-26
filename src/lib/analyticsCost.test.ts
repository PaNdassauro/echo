import { describe, expect, it } from "vitest";
import { computeCost } from "./analyticsCost";

describe("computeCost", () => {
    it("não cobra API dentro da franquia de 1000", () => {
        const c = computeCost(0, 800);
        expect(c.apiCost).toBe(0);
        expect(c.billableApiMessages).toBe(0);
        expect(c.freeApiMessagesUsed).toBe(800);
    });

    it("cobra só o excedente da franquia", () => {
        const c = computeCost(0, 1500);
        expect(c.billableApiMessages).toBe(500);
        expect(c.apiCost).toBeCloseTo(20);
        expect(c.freeApiMessagesUsed).toBe(1000);
    });

    it("template não entra na franquia", () => {
        const c = computeCost(100, 1000);
        expect(c.templateCost).toBeCloseTo(31);
        expect(c.apiCost).toBe(0);
        expect(c.totalCost).toBeCloseTo(31);
    });

    it("trata zero", () => {
        expect(computeCost(0, 0).totalCost).toBe(0);
    });
});
