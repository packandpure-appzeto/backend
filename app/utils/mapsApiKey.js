/**
 * Resolve Google Maps API key for server-side Geocoding / Directions.
 * Accepts GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_SERVER_KEY, or VITE_GOOGLE_MAPS_API_KEY
 * (same name as frontend .env when copied into backend/.env).
 */
export function getGoogleMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    process.env.GOOGLE_MAPS_SERVER_KEY?.trim() ||
    process.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ||
    ""
  );
}

export const GOOGLE_MAPS_KEY_HINT =
  "Set GOOGLE_MAPS_API_KEY or VITE_GOOGLE_MAPS_API_KEY in backend/.env (enable Geocoding API).";
