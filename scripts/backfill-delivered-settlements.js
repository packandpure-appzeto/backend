import dotenv from "dotenv";
import connectDB from "../app/dbConfig/dbConfig.js";
import Order from "../app/models/order.js";
import Transaction from "../app/models/transaction.js";
import { applyDeliveredSettlement } from "../app/services/orderSettlement.js";

dotenv.config();

async function run() {
  await connectDB();
  const deliveredOrders = await Order.find({ status: "delivered" }).lean();
  console.log(`[Backfill] Found ${deliveredOrders.length} delivered orders.`);

  for (const o of deliveredOrders) {
    const existingTx = await Transaction.findOne({
      order: o._id,
      type: "Delivery Earning"
    });

    if (!existingTx) {
      console.log(`[Backfill] Order ${o.orderId} is missing delivery earning transaction. Creating now...`);
      await applyDeliveredSettlement(o, o.orderId);
      console.log(`[Backfill] Order ${o.orderId} settlements generated.`);
    } else {
      console.log(`[Backfill] Order ${o.orderId} already has delivery earning transaction.`);
    }
  }

  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
