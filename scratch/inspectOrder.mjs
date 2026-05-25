import "dotenv/config";
import mongoose from "mongoose";

import Order from "../app/models/order.js";
import PurchaseRequest from "../app/models/purchaseRequest.js";

const raw = String(process.argv[2] || "").trim();
const clean = raw.replace(/^#/, "");
const variants = Array.from(new Set([clean, `#${clean}`, raw].filter(Boolean)));

if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is missing in environment.");
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);

const order = await Order.findOne({ orderId: { $in: variants } }).lean();
if (!order) {
  const fallback = clean
    ? await Order.find({ orderId: { $regex: clean, $options: "i" } })
        .select("orderId status workflowStatus workflowVersion hubStatus supplyChainStatus cancelledBy cancelReason createdAt updatedAt")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
    : [];

  console.log("ORDER_NOT_FOUND", { variants, fallbackMatches: fallback });
  await mongoose.disconnect();
  process.exit(0);
}

const prs = await PurchaseRequest.find({ orderId: order._id })
  .select("requestId status vendorId items.shortageQty items.productId createdAt updatedAt")
  .lean();

console.log(
  JSON.stringify(
    {
      orderId: order.orderId,
      _id: String(order._id),
      status: order.status,
      workflowStatus: order.workflowStatus,
      workflowVersion: order.workflowVersion,
      hubStatus: order.hubStatus,
      supplyChainStatus: order.supplyChainStatus,
      procurementRequired: order.procurementRequired,
      cancelledBy: order.cancelledBy,
      cancelReason: order.cancelReason,
      deliveryBoy: order.deliveryBoy,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      prsCount: prs.length,
      prs,
    },
    null,
    2,
  ),
);

await mongoose.disconnect();
