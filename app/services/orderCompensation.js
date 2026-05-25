import Product from "../models/product.js";
import StockHistory from "../models/stockHistory.js";
import Transaction from "../models/transaction.js";

/**
 * Reverse stock and fail seller transaction when an order is cancelled
 * after stock was deducted at placement.
 */
export async function compensateOrderCancellation(order, orderIdString) {
  for (const item of order.items) {
    await Product.findByIdAndUpdate(item.product, {
      $inc: { stock: item.quantity },
    });

    await StockHistory.create({
      product: item.product,
      seller: order.seller,
      type: "Correction",
      quantity: item.quantity,
      note: `Order #${orderIdString} Cancelled`,
      order: order._id,
    });
    // --- HUB STOCK REVERSAL ---
    if (order.hubFlowEnabled) {
      try {
        const HubInventory = (await import("../models/hubInventory.js")).default;
        const hubId = process.env.DEFAULT_HUB_ID || "MAIN_HUB";
        
        await HubInventory.findOneAndUpdate(
          { hubId, productId: item.product },
          { 
            $inc: { 
              availableQty: item.quantity,
              reservedQty: -item.quantity
            } 
          }
        );
        console.log(`[InventorySync] Reversed ${item.quantity} units from reserved to available for Order #${orderIdString}`);
      } catch (err) {
        console.warn("[InventorySync] Hub reversal failed during compensation:", err.message);
      }
    }
  }

  await Transaction.findOneAndUpdate(
    { reference: orderIdString },
    { status: "Failed" },
  );
}
