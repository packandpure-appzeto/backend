import { distanceMeters } from "./geoUtils.js";
import Setting from "../models/setting.js";

/**
 * Calculates delivery fee based on distance between hub and customer.
 * @param {Object} customerCoords - { lat, lng }
 * @returns {Promise<Object>} { distanceKm, deliveryFee, isFree }
 */
export async function calculateDeliveryFee(customerCoords) {
  try {
    const settings = await Setting.findOne().lean();
    
    // Default values if settings not found
    const hubCoords = settings?.hubLocation?.coordinates || [75.8975, 22.7533]; // [lng, lat]
    const [hubLng, hubLat] = hubCoords;
    const { lat: custLat, lng: custLng } = customerCoords;

    if (!Number.isFinite(custLat) || !Number.isFinite(custLng)) {
      return { 
        distanceKm: 0, 
        deliveryFee: settings?.baseDeliveryFee ?? 20, 
        platformFee: settings?.platformFee ?? 3,
        gstPercentage: 0,
        isOutOfRange: false 
      };
    }

    // 1. Calculate straight line distance (Haversine)
    const distanceM = distanceMeters(hubLat, hubLng, custLat, custLng);
    const distanceKm = Number((distanceM / 1000).toFixed(2));

    // 2. Calculate fee: Base + (Dist > baseFreeKm ? extra * PerKm : 0)
    const baseDeliveryFee = settings?.baseDeliveryFee ?? 20;
    const baseFreeKm = settings?.baseFreeKm ?? 1;
    const perKmCharge = settings?.perKmDeliveryCharge ?? 10;
    const freeDeliveryThreshold = settings?.freeDeliveryThreshold ?? 500;
    const platformFee = settings?.platformFee ?? 3;
    const gstPercentage = 0; // Shifted to item-level taxation
    const maxServiceRadius = settings?.maxServiceRadius ?? 15;

    let deliveryFee = baseDeliveryFee;
    if (distanceKm > baseFreeKm) {
      deliveryFee += (distanceKm - baseFreeKm) * perKmCharge;
    }

    const isOutOfRange = distanceKm > maxServiceRadius;

    return {
      distanceKm: Math.round(distanceKm * 10) / 10,
      deliveryFee: Math.round(deliveryFee),
      baseDeliveryFee,
      baseFreeKm,
      perKmCharge,
      freeDeliveryThreshold,
      platformFee,
      gstPercentage,
      maxServiceRadius,
      isOutOfRange
    };
  } catch (error) {
    console.error("Delivery fee calculation error:", error);
    return {
      distanceKm: 0,
      deliveryFee: 20,
      platformFee: 3,
      gstPercentage: 0,
      isOutOfRange: false
    };
  }
}
