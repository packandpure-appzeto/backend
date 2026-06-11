import dotenv from "dotenv";
import mongoose from "mongoose";
import Seller from "../app/models/seller.js";
import Product from "../app/models/product.js";
import Order from "../app/models/order.js";
import { MONGO_CATALOG_STOCK_EXPR } from "../app/utils/productHelpers.js";

dotenv.config();

const id = process.argv[2] || "6a22833136a7b6c9f88df044";

await mongoose.connect(process.env.MONGO_URI);

const seller = await Seller.findById(id).select("-password -otp -otpExpiry").lean();
if (!seller) {
  console.log("SELLER NOT FOUND");
  process.exit(1);
}

console.log("=== SELLER ===");
console.log(JSON.stringify(seller, null, 2));

const products = await Product.find({ sellerId: id, ownerType: "seller" })
  .select("name status stock variants purchasePrice masterProductId")
  .populate("masterProductId", "name")
  .lean();

console.log("\n=== PRODUCTS (" + products.length + ") ===");
for (const p of products) {
  const vs = (p.variants || []).reduce((s, v) => s + (Number(v.stock) || 0), 0);
  const stock = vs > 0 ? vs : Number(p.stock) || 0;
  console.log(
    `- ${p.name} | stock: ${stock} | status: ${p.status} | cost: ${p.purchasePrice} | master: ${p.masterProductId?.name || "none"}`,
  );
}

const agg = await Product.aggregate([
  { $match: { sellerId: new mongoose.Types.ObjectId(id), ownerType: "seller" } },
  {
    $group: {
      _id: null,
      total: { $sum: 1 },
      active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
      pending: { $sum: { $cond: [{ $eq: ["$status", "pending_approval"] }, 1, 0] } },
      totalStock: { $sum: MONGO_CATALOG_STOCK_EXPR },
    },
  },
]);

console.log("\n=== PRODUCT STATS ===");
console.log(agg[0] || {});

const orders = await Order.countDocuments({ seller: id });
console.log("\n=== ORDER COUNT ===", orders);

await mongoose.disconnect();
