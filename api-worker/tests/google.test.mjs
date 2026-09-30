import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = fileURLToPath(
    new URL("../dist/test/google.cjs", import.meta.url),
);
await build({
    entryPoints: [fileURLToPath(new URL("../src/google.ts", import.meta.url))],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
});
const api = createRequire(import.meta.url)(output);
const seed = {
    name: "Example Station",
    brand: "Example",
    street: "1 Test Road",
    suburb: "PERTH",
    latitude: -31.95,
    longitude: 115.86,
};
const now = Date.parse("2026-09-29T08:00:00Z");
const place = (extra = {}) => ({
    id: "test_place",
    displayName: { text: "Example Station" },
    types: ["gas_station"],
    location: { latitude: -31.95, longitude: 115.86 },
    businessStatus: "OPERATIONAL",
    addressComponents: [
        { types: ["country"], shortText: "AU" },
        { types: ["administrative_area_level_1"], shortText: "WA" },
        { types: ["postal_code"], longText: "6000" },
        { types: ["street_number"], longText: "1" },
        { types: ["route"], longText: "Test Road" },
        { types: ["locality"], longText: "Perth" },
    ],
    internationalPhoneNumber: "+61 8 9981 1151",
    restroom: true,
    regularOpeningHours: {
        periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
    },
    attributions: [
        { displayName: "Example provider", uri: "https://example.com" },
    ],
    ...extra,
});

test("Google search uses a field mask, secret header and a single bounded request", async () => {
    let requests = 0;
    const result = await api.lookupPlace(seed, "test-secret", {
        now,
        refreshDays: 7,
        fetcher: async (url, init) => {
            requests++;
            assert.equal(
                String(url),
                "https://places.googleapis.com/v1/places:searchText",
            );
            assert.equal(init.headers["X-Goog-Api-Key"], "test-secret");
            assert.ok(!init.headers["X-Goog-FieldMask"].includes("*"));
            assert.equal(JSON.parse(init.body).includedType, "gas_station");
            return Response.json({ places: [place()] });
        },
    });
    assert.equal(requests, 1);
    assert.equal(result.postcode, "6000");
    assert.equal(result.phone, "+61899811151");
    assert.equal(result.is24Hours, true);
    assert.ok(result.features.includes("Toilets"));
    assert.equal(result.attributions[0].displayName, "Example provider");
});

test("stored place IDs use Details and are still matched to the station", async () => {
    const result = await api.lookupPlace(seed, "key", {
        now,
        placeId: "test_place",
        fetcher: async (url) => {
            assert.equal(
                String(url),
                "https://places.googleapis.com/v1/places/test_place",
            );
            return Response.json(place());
        },
    });
    assert.equal(result.placeId, "test_place");
});

test("wrong, distant, closed and ambiguous places are not used", async () => {
    for (const places of [
        [
            place({
                displayName: { text: "Different business" },
                location: { latitude: -31.951, longitude: 115.86 },
            }),
        ],
        [place({ location: { latitude: -32.0, longitude: 115.86 } })],
        [place({ businessStatus: "CLOSED_PERMANENTLY" })],
        [
            place({
                addressComponents: place().addressComponents.map((component) =>
                    component.types.includes("street_number")
                        ? { ...component, longText: "55" }
                        : component,
                ),
            }),
        ],
        [place(), place({ id: "another_place" })],
    ]) {
        assert.equal(
            await api.lookupPlace(seed, "key", {
                now,
                fetcher: async () => Response.json({ places }),
            }),
            null,
        );
    }
});

test("Billabong matches despite lot notation and a highway route alias", async () => {
    const billabong = {
        name: "Billabong Roadhouse",
        brand: "Independent",
        street: "Lot 2 North West Coastal Hwy",
        suburb: "MEADOW",
        latitude: -26.816033,
        longitude: 114.614261,
    };
    const candidate = place({
        displayName: { text: "Billabong Roadhouse" },
        location: { latitude: -26.8161973, longitude: 114.6141228 },
        addressComponents: [
            ...place().addressComponents.filter(
                (value) =>
                    !value.types.some((type) =>
                        ["street_number", "route", "locality"].includes(type),
                    ),
            ),
            { types: ["street_number"], longText: "Lot 2" },
            { types: ["route"], longText: "Tourist Drive 354" },
            { types: ["locality"], longText: "Meadow" },
        ],
    });
    let requests = 0;
    const result = await api.lookupPlace(billabong, "key", {
        now,
        fetcher: async () => {
            requests++;
            return Response.json({
                places: [
                    candidate,
                    {
                        ...candidate,
                        id: "neighbour",
                        displayName: { text: "Billabong Homestead Hotel" },
                        location: {
                            latitude: -26.816698,
                            longitude: 114.614426,
                        },
                    },
                ],
            });
        },
    });
    assert.equal(result?.placeId, "test_place");
    assert.equal(requests, 1);
});

test("distinctive exact names at the same forecourt tolerate corner-address differences", async () => {
    const corner = {
        ...seed,
        name: "Caltex Bunbury South",
        brand: "Caltex",
        street: "1 Brittain Rd",
        suburb: "CAREY PARK",
        latitude: -33.360416,
        longitude: 115.643581,
    };
    const candidate = place({
        displayName: { text: corner.name },
        location: { latitude: -33.3602521, longitude: 115.6437037 },
        addressComponents: place().addressComponents.map((value) =>
            value.types.includes("route")
                ? { ...value, longText: "Bussell Highway" }
                : value.types.includes("street_number")
                  ? { ...value, longText: "140" }
                  : value.types.includes("locality")
                    ? { ...value, longText: "GELORUP" }
                    : value,
        ),
    });
    assert.equal(
        (
            await api.lookupPlace(corner, "key", {
                now,
                fetcher: async () => Response.json({ places: [candidate] }),
            })
        )?.placeId,
        "test_place",
    );
});

test("address fallback finds a renamed station and reserves each request", async () => {
    const source = { ...seed, name: "Old Village Fuel", brand: "BP" };
    let calls = 0;
    let reserved = 0;
    const result = await api.lookupPlace(source, "key", {
        now,
        beforeRequest: async () => {
            reserved++;
        },
        fetcher: async (_url, init) => {
            calls++;
            const query = JSON.parse(init.body).textQuery;
            if (calls === 1) {
                assert.ok(query.includes(source.name));
                return Response.json({});
            }
            assert.ok(!query.includes(source.name));
            assert.ok(query.includes(source.street));
            return Response.json({
                places: [place({ displayName: { text: "BP" } })],
            });
        },
    });
    assert.equal(result?.placeId, "test_place");
    assert.equal(calls, 2);
    assert.equal(reserved, 2);
    const refreshed = await api.lookupPlace(source, "key", {
        now,
        placeId: result.placeId,
        fetcher: async (url) => {
            assert.equal(url.pathname, "/v1/places/test_place");
            return Response.json(place({ displayName: { text: "BP" } }));
        },
    });
    assert.equal(refreshed?.placeId, result.placeId);
});

test("fallback remains bounded, cannot choose an ambiguous site or exceed the budget", async () => {
    let calls = 0;
    await assert.rejects(
        api.lookupPlace(seed, "key", {
            now,
            beforeRequest: async () => {
                if (calls === 1)
                    throw new api.GoogleLookupError("budget_exhausted");
            },
            fetcher: async () => {
                calls++;
                return Response.json({});
            },
        }),
        { code: "budget_exhausted" },
    );
    assert.equal(calls, 1);
    calls = 0;
    assert.equal(
        await api.lookupPlace(seed, "key", {
            now,
            fetcher: async () => {
                calls++;
                return Response.json({
                    places: [place(), place({ id: "neighbour" })],
                });
            },
        }),
        null,
    );
    assert.equal(calls, 1);
    calls = 0;
    assert.equal(
        await api.lookupPlace(seed, "key", {
            now,
            fetcher: async () => {
                calls++;
                return Response.json({});
            },
        }),
        null,
    );
    assert.equal(calls, 2);
});

test("a shared suburb cannot match a competing neighbouring station", async () => {
    const nearby = { ...seed, name: "BP Perth", brand: "BP" };
    assert.equal(
        await api.lookupPlace(nearby, "key", {
            now,
            fetcher: async () =>
                Response.json({
                    places: [place({ displayName: { text: "Shell Perth" } })],
                }),
        }),
        null,
    );
});

test("a shared generic name cannot match a different brand or street", async () => {
    const nearby = { ...seed, name: "BP Service Centre", brand: "BP" };
    for (const candidate of [
        place({ displayName: { text: "Shell Service Centre" } }),
        place({
            displayName: { text: "BP Service Centre" },
            addressComponents: place().addressComponents.map((value) =>
                value.types.includes("route")
                    ? { ...value, longText: "Other Road" }
                    : value,
            ),
        }),
    ]) {
        assert.equal(
            await api.lookupPlace(nearby, "key", {
                now,
                fetcher: async () => Response.json({ places: [candidate] }),
            }),
            null,
        );
    }
});

test("provider errors expose safe classifications and never log secret or response bodies", async () => {
    for (const [status, code] of [
        [403, "configuration"],
        [429, "rate_limited"],
        [503, "upstream"],
    ]) {
        await assert.rejects(
            api.lookupPlace(seed, "test-secret", {
                now,
                fetcher: async () => new Response("test-secret", { status }),
            }),
            { code },
        );
    }
});

test("budget storage failures propagate without attempting a provider request", async () => {
    const failure = new Error("D1 unavailable");
    await assert.rejects(
        api.lookupPlace(seed, "key", {
            beforeRequest: async () => {
                throw failure;
            },
            fetcher: async () =>
                assert.fail("Google must not be called without a reservation"),
        }),
        (error) => error === failure,
    );
});

test("Google hours split overnight periods and preserve multiple shifts", () => {
    const result = api.googleHours({
        periods: [
            {
                open: { day: 1, hour: 22, minute: 0 },
                close: { day: 2, hour: 2, minute: 0 },
            },
            {
                open: { day: 2, hour: 8, minute: 0 },
                close: { day: 2, hour: 12, minute: 0 },
            },
        ],
    });
    assert.equal(result.hours.Monday, "22:00-24:00");
    assert.equal(result.hours.Tuesday, "00:00-02:00, 08:00-12:00");
    assert.equal(result.hours.Sunday, "Closed");
    assert.equal(result.is24Hours, false);
    assert.deepEqual(
        api.googleHours({ periods: [{ open: { day: 8, hour: 0 } }] }),
        { hours: {}, is24Hours: null },
    );
});

test("malformed provider envelopes fail safely instead of becoming a negative match", async () => {
    for (const value of [
        [],
        null,
        { places: "bad" },
        { places: [false] },
        { places: [{}] },
        { places: [{ id: "test_place" }] },
        { places: [place({ location: null })] },
    ]) {
        await assert.rejects(
            api.lookupPlace(seed, "key", {
                now,
                fetcher: async () => Response.json(value),
            }),
            { code: "invalid_response" },
        );
    }
    await assert.rejects(
        api.lookupPlace(seed, "key", {
            now,
            placeId: "test_place",
            fetcher: async () => Response.json({}),
        }),
        { code: "invalid_response" },
    );
    for (const value of [{}, { places: [] }]) {
        assert.equal(
            await api.lookupPlace(seed, "key", {
                now,
                fetcher: async () => Response.json(value),
            }),
            null,
        );
    }
});
