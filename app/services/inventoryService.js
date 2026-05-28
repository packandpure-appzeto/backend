import HubInventory from "../models/hubInventory.js";
import Product from "../models/product.js";

/**
 * Service to manage Hub Inventory.
 * Requirements: hubInventory collection, product-hub stock management.
 */

export const getHubStock = async (productId, hubLocation) => {
  const hubId = hubLocation || process.env.DEFAULT_HUB_ID || "MAIN_HUB";
  return await HubInventory.findOne({ productId, hubId });
};

export const updateHubStock = async (productId, hubLocation, delta) => {
  const hubId = hubLocation || process.env.DEFAULT_HUB_ID || "MAIN_HUB";
  return await HubInventory.findOneAndUpdate(
    { productId, hubId },
    { $inc: { availableQty: delta }, $set: { lastUpdated: new Date() } },
    { new: true, upsert: true }
  );
};

export const reserveStock = async (productId, hubLocation, quantity) => {
  const hubId = hubLocation || process.env.DEFAULT_HUB_ID || "MAIN_HUB";
  const inventory = await HubInventory.findOne({ productId, hubId });
  if (!inventory || inventory.availableQty < quantity) {
    return { success: false, available: inventory?.availableQty || 0 };
  }
  
  inventory.availableQty -= quantity;
  inventory.reservedQty += quantity;
  await inventory.save();
  return { success: true, inventory };
};

export const releaseStock = async (productId, hubLocation, quantity) => {
  const hubId = hubLocation || process.env.DEFAULT_HUB_ID || "MAIN_HUB";
  return await HubInventory.findOneAndUpdate(
    { productId, hubId },
    { $inc: { availableQty: quantity, reservedQty: -quantity } },
    { new: true }
  );
};
