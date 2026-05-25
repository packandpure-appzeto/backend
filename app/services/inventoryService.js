import HubInventory from "../models/hubInventory.js";
import Product from "../models/product.js";

/**
 * Service to manage Hub Inventory.
 * Requirements: hubInventory collection, product-hub stock management.
 */

export const getHubStock = async (productId, hubLocation) => {
  return await HubInventory.findOne({ productId, hubLocation });
};

export const updateHubStock = async (productId, hubLocation, delta) => {
  return await HubInventory.findOneAndUpdate(
    { productId, hubLocation },
    { $inc: { availableQty: delta }, $set: { lastUpdated: new Date() } },
    { new: true, upsert: true }
  );
};

export const reserveStock = async (productId, hubLocation, quantity) => {
  const inventory = await HubInventory.findOne({ productId, hubLocation });
  if (!inventory || inventory.availableQty < quantity) {
    return { success: false, available: inventory?.availableQty || 0 };
  }
  
  inventory.availableQty -= quantity;
  inventory.reservedQty += quantity;
  await inventory.save();
  return { success: true, inventory };
};

export const releaseStock = async (productId, hubLocation, quantity) => {
  return await HubInventory.findOneAndUpdate(
    { productId, hubLocation },
    { $inc: { availableQty: quantity, reservedQty: -quantity } },
    { new: true }
  );
};
