import Transaction from "../models/transaction.js";

/**
 * Financial side effects when order becomes delivered (mirrors orderController).
 */
export async function applyDeliveredSettlement(order, orderIdString) {
  // In Hub-First flow, customer payments belong to the Admin/Hub.
  // Sellers are paid separately through Purchase Request settlements.
  console.log(`[Settlement] Order ${orderIdString} delivered. Product amount belongs to Hub Admin.`);
  
  // Optional: You could create an 'Admin Earning' transaction here if needed for accounting.
  await Transaction.create({
    user: null, // Admin/Platform
    userModel: "Admin",
    order: order._id,
    type: "Order Sale",
    amount: (order.pricing?.total || 0) - (order.pricing?.deliveryFee || 0),
    status: "Settled",
    reference: `ADM-SALE-${orderIdString}`,
  });

  // 2. Seller Earnings (Supply Cost)
  // Calculate total supply cost for this order
  const supplyCost = order.items.reduce((acc, item) => {
    return acc + ((item.purchasePrice || item.price) * item.quantity);
  }, 0);

  if (order.seller) {
    await Transaction.create({
      user: order.seller,
      userModel: "Seller",
      order: order._id,
      type: "Supply Earning",
      amount: supplyCost,
      status: "Settled",
      reference: `SUP-ERN-${orderIdString}`,
    });
  }

  // 3. Delivery Partner Earnings & Cash Collection
  if (order.deliveryBoy) {
    const deliveryEarning = Math.max(order.pricing?.deliveryFee || 0, 25); // Min payout ₹25 even if free delivery
    await Transaction.create({
      user: order.deliveryBoy,
      userModel: "Delivery",
      order: order._id,
      type: "Delivery Earning",
      amount: deliveryEarning,
      status: "Settled",
      reference: `DEL-ERN-${orderIdString}`,
    });

    const method = (order.payment?.method || "").toLowerCase();
    if (method === "cash" || method === "cod") {
      await Transaction.create({
        user: order.deliveryBoy,
        userModel: "Delivery",
        order: order._id,
        type: "Cash Collection",
        amount: order.pricing.total,
        status: "Settled",
        reference: `CASH-COL-${orderIdString}`,
      });
    }
  }
}
