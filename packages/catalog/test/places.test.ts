import { describe, expect, it } from "vitest";
import { expandPlaces } from "../src/index.ts";

describe("expandPlaces", () => {
  it("expands city aliases to the strings postings use", () => {
    const nyc = expandPlaces(["NYC"]);
    expect(nyc.remote).toBe(false);
    expect(nyc.locations).toEqual(expect.arrayContaining(["New York", "Brooklyn", "Queens"]));

    expect(expandPlaces(["Bay Area"]).locations).toEqual(
      expect.arrayContaining(["San Francisco", "San Jose", "Palo Alto", "Silicon Valley"]),
    );
    expect(expandPlaces(["Bengaluru"]).locations).toEqual(
      expect.arrayContaining(["Bengaluru", "Bangalore", "Whitefield"]),
    );
  });

  it("matches the same entry however the person writes it", () => {
    const canonical = expandPlaces(["Los Angeles"]).locations;
    expect(expandPlaces(["LA"]).locations).toEqual(canonical);
    expect(expandPlaces(["los angeles!"]).locations).toEqual(canonical);
    expect(expandPlaces(["  Greater   Los Angeles "]).locations).toEqual(canonical);
    expect(expandPlaces(["Washington, DC"]).locations).toEqual(expandPlaces(["d.c."]).locations);
  });

  it("passes unknown words through as the person wrote them", () => {
    expect(expandPlaces(["Boise"])).toEqual({ remote: false, locations: ["Boise"] });
    expect(expandPlaces(["  Tallinn "]).locations).toEqual(["Tallinn"]);
  });

  it("never emits a bare LA: Louisiana is not Los Angeles", () => {
    const la = expandPlaces(["la"]).locations;
    expect(la).not.toContain("LA");
    expect(la).toContain("Los Angeles");
    // A person who names Louisiana gets their own word, not the Los Angeles list.
    expect(expandPlaces(["Louisiana"])).toEqual({ remote: false, locations: ["Louisiana"] });
  });

  it("keeps Washington state apart from Washington, DC", () => {
    const state = expandPlaces(["Washington"]).locations;
    expect(state).toEqual(expect.arrayContaining(["Seattle", "Bellevue", "WA"]));
    expect(state).not.toContain("Washington, DC");
    expect(state).not.toContain("Washington");

    const capital = expandPlaces(["Washington DC"]).locations;
    expect(capital).toContain("Washington, DC");
    expect(capital).not.toContain("Seattle");
    expect(expandPlaces(["DC"]).locations).toEqual(capital);
  });

  it("uses state names for state words, and never a bare NY or WA token in a city list", () => {
    expect(expandPlaces(["Texas"]).locations).toEqual(["Texas", "TX"]);
    expect(expandPlaces(["Austin"]).locations).not.toContain("TX");
    expect(expandPlaces(["NYC"]).locations).not.toContain("NY");
    expect(expandPlaces(["Seattle"]).locations).not.toContain("WA");
  });

  it("turns remote words into a flag, not a location string", () => {
    expect(expandPlaces(["remote"])).toEqual({ remote: true, locations: [] });
    expect(expandPlaces(["Seattle", "work from home"])).toEqual({
      remote: true,
      locations: expandPlaces(["Seattle"]).locations,
    });
  });

  it("drops duplicates across entries and ignores words with no letters or digits", () => {
    const both = expandPlaces(["Seattle", "Seattle area", "--", ""]);
    expect(both.remote).toBe(false);
    expect(new Set(both.locations).size).toBe(both.locations.length);
    expect(both.locations).toContain("Redmond");
    expect(expandPlaces(["  ", "!!"])).toEqual({ remote: false, locations: [] });
  });

  it("covers every place the experiment tested", () => {
    for (const word of [
      "NYC",
      "New York",
      "Bay Area",
      "San Francisco",
      "Silicon Valley",
      "Seattle",
      "Austin",
      "Dallas",
      "DFW",
      "Houston",
      "Los Angeles",
      "Boston",
      "Chicago",
      "Denver",
      "Atlanta",
      "DC",
      "Toronto",
      "Vancouver",
      "London",
      "Dublin",
      "Berlin",
      "Bengaluru",
      "Bangalore",
      "Hyderabad",
      "Pune",
      "Mumbai",
      "Delhi",
      "Gurgaon",
      "Chennai",
      "Singapore",
      "Sydney",
    ]) {
      const { locations, remote } = expandPlaces([word]);
      expect(remote || locations.length > 0, word).toBe(true);
      // An alias must expand to more than the word itself, or it is not doing anything.
      expect(locations.length, word).toBeGreaterThan(0);
    }
  });
});
