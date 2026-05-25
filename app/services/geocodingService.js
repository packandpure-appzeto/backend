import { Client } from "@googlemaps/google-maps-services-js";
import {
  getGoogleMapsApiKey,
  GOOGLE_MAPS_KEY_HINT,
} from "../utils/mapsApiKey.js";

const client = new Client({});

function pickBestResult(results = []) {
  if (!Array.isArray(results) || !results.length) return null;
  const preferred =
    results.find((r) => r.types?.includes("street_address")) ||
    results.find((r) => r.types?.includes("premise")) ||
    results.find((r) => r.types?.includes("establishment")) ||
    results[0];
  return preferred;
}

/**
 * Reverse geocode coordinates → formatted address.
 */
export async function reverseGeocode(lat, lng) {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    const err = new Error(`Google Maps API key is not configured on the server. ${GOOGLE_MAPS_KEY_HINT}`);
    err.code = "MAPS_KEY_MISSING";
    throw err;
  }

  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("Invalid latitude");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Invalid longitude");
  }

  const resp = await client.reverseGeocode({
    params: {
      latlng: { lat: latitude, lng: longitude },
      key: apiKey,
    },
    timeout: 10000,
  });

  const status = resp.data?.status;
  if (status !== "OK") {
    const msg = resp.data?.error_message || status || "Reverse geocode failed";
    throw new Error(msg);
  }

  const best = pickBestResult(resp.data.results);
  if (!best) {
    throw new Error("No address found for this location");
  }

  return {
    address: best.formatted_address || "",
    lat: latitude,
    lng: longitude,
    placeId: best.place_id || null,
    components: best.address_components || [],
  };
}

/**
 * Forward geocode address text → coordinates + formatted address.
 */
export async function geocodeAddress(address) {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    const err = new Error(`Google Maps API key is not configured on the server. ${GOOGLE_MAPS_KEY_HINT}`);
    err.code = "MAPS_KEY_MISSING";
    throw err;
  }

  const query = String(address || "").trim();
  if (!query || query.length < 5) {
    throw new Error("Enter a complete store address (at least 5 characters)");
  }

  const resp = await client.geocode({
    params: {
      address: query,
      key: apiKey,
      region: "in",
      components: { country: "IN" },
    },
    timeout: 10000,
  });

  const status = resp.data?.status;
  if (status !== "OK") {
    const msg = resp.data?.error_message || status || "Address not found";
    throw new Error(msg);
  }

  const best = pickBestResult(resp.data.results);
  if (!best?.geometry?.location) {
    throw new Error("Could not locate this address on the map");
  }

  return {
    address: best.formatted_address || query,
    lat: Number(best.geometry.location.lat),
    lng: Number(best.geometry.location.lng),
    placeId: best.place_id || null,
    components: best.address_components || [],
  };
}
