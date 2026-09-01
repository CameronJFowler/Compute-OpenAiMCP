import { describe, expect, it } from "vitest";

import { DATASETS } from "../src/config";
import { routeDataset, routedDataset } from "../src/engine/dataset-router";

describe("routeDataset", () => {
  it.each([
    ["Do Adelie and Gentoo penguins differ in body mass?", "penguins"],
    ["How much of global temperature variation is explained by CO2?", "climate_annual"],
    ["Estimate Hubble's constant from galaxy velocity and distance.", "hubble_1929"],
    ["Do Fama-French market and value factors explain returns?", "ff_factors_daily"],
    ["Does industry momentum survive out of sample transaction costs?", "industries_daily"],
  ])("routes %s to %s", (question, datasetId) => {
    const route = routeDataset(question);
    expect(route.datasetId).toBe(datasetId);
    expect(route.fallback).toBe(false);
    expect(route.matchedTerms.length).toBeGreaterThan(0);
  });

  it("falls back to the quantitative panel for an underspecified question", () => {
    const route = routeDataset("What is interesting here?");
    expect(route.datasetId).toBe("industries_daily");
    expect(route.fallback).toBe(true);
  });

  it("never returns an id absent from the live manifest", () => {
    const route = routedDataset("Tell me about a galaxy", DATASETS);
    expect(DATASETS.map((dataset) => dataset.id)).toContain(route.datasetId);
  });
});
