import mongoose from "mongoose";
import Delivery from "./app/models/delivery.js";
import Order from "./app/models/order.js";
import Transaction from "./app/models/transaction.js";
import DeliveryActivity from "./app/models/deliveryActivity.js";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to DB");

    const delivery = await Delivery.findOne();
    if (!delivery) {
      console.log("No delivery partner found");
      process.exit(0);
    }
    console.log("Found delivery partner:", delivery._id);

    const id = delivery._id;

    const rider = await Delivery.findById(id).lean();
    console.log("Rider:", rider);

    const recentOrders = await Order.find({ deliveryBoy: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("customer", "name")
      .populate("seller", "shopName")
      .lean();
    console.log("Recent Orders count:", recentOrders.length);

    const totalOrders = await Order.countDocuments({ deliveryBoy: id, status: "delivered" });

    const earningsAggr = await Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(id), userModel: "Delivery", type: "Delivery Earning" } },
      { $group: { _id: null, totalEarnings: { $sum: "$amount" } } }
    ]);
    const todayAggr = await Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(id), userModel: "Delivery", type: "Delivery Earning", createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } } },
      { $group: { _id: null, todayEarnings: { $sum: "$amount" } } }
    ]);

    const activityLogs = await DeliveryActivity.find({ deliveryBoy: id });
    console.log("Activity logs count:", activityLogs.length);

    console.log("Earnings:", earningsAggr, todayAggr);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

test();
