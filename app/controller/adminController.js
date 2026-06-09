import mongoose from "mongoose";
import Admin from "../models/admin.js";
import User from "../models/customer.js";
import Seller from "../models/seller.js";
import Delivery from "../models/delivery.js";
import DeliveryActivity from "../models/deliveryActivity.js";
import Order from "../models/order.js";
import Product from "../models/product.js";
import Transaction from "../models/transaction.js";
import Notification from "../models/notification.js";
import Setting from "../models/setting.js";
import PickupPartner from "../models/pickupPartner.js";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import Category from "../models/category.js";

/** Use Cloudinary `avatar` when set; otherwise Dicebear placeholder */
const customerAvatarProjection = {
  $cond: {
    if: { $gt: [{ $strLenCP: { $ifNull: ["$avatar", ""] } }, 0] },
    then: "$avatar",
    else: {
      $concat: [
        "https://api.dicebear.com/7.x/avataaars/svg?seed=",
        { $ifNull: ["$phone", { $ifNull: ["$name", "Customer"] }] },
      ],
    },
  },
};

/* ===============================
   GET ADMIN DASHBOARD STATS
================================ */
export const getAdminStats = async (req, res) => {
  try {
    // 1. Basic Counts
    const [
      totalCustomers, 
      totalSellers, 
      totalRiders, 
      totalOrders,
      newOrderCount,
      allCategoryCount,
      inactiveSellerCount
    ] = await Promise.all([
        User.countDocuments({ role: { $in: ["user", "customer"] } }),
        Seller.countDocuments(),
        Delivery.countDocuments(),
        Order.countDocuments(),
        Order.countDocuments({ status: "pending" }),
        Category.countDocuments(),
        Seller.countDocuments({ isVerified: false })
      ]);

    const totalUsers = totalCustomers + totalSellers + totalRiders;
    const activeSellers = totalSellers - inactiveSellerCount;

    // 2. Revenue calculation
    const revenueData = await Order.aggregate([
      { $match: { status: "delivered" } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]);
    const totalRevenue = revenueData[0]?.total || 0;

    // 3. Revenue History (Last 7 Days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const historyAggregation = await Order.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo }, status: "delivered" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$pricing.total" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Map aggregation to day names for frontend
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const revenueHistory = historyAggregation.map((item) => ({
      name: days[new Date(item._id).getDay()],
      revenue: item.revenue,
    }));

    // 4. Recent Orders
    const recentOrders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("customer", "name");

    // 5. Category Distribution (Mock logic for now based on orders if products don't have categories)
    const categoryData = await Product.aggregate([
      { $group: { _id: "$headerId", count: { $sum: 1 } } },
      {
        $lookup: {
          from: "categories",
          localField: "_id",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: "$category" },
      { $project: { name: "$category.name", value: "$count" } },
      { $limit: 4 },
    ]);

    // 6. Top Products
    const topProducts = await Order.aggregate([
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product",
          sales: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } },
        },
      },
      { $sort: { sales: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $project: {
          name: "$product.name",
          sales: 1,
          rev: "$revenue",
          icon: { $literal: "📦" },
        },
      },
    ]);

    return handleResponse(res, 200, "Admin stats fetched successfully", {
      overview: {
        totalUsers,
        activeSellers,
        totalOrders,
        totalRevenue,
        newOrderCount,
        allCategoryCount,
        inactiveSellerCount,
      },
      revenueHistory,
      recentOrders: recentOrders.map((o) => ({
        id: o.orderId,
        customer: o.customer?.name || "Guest",
        statusText: o.status,
        status:
          o.status === "delivered"
            ? "success"
            : o.status === "cancelled"
              ? "error"
              : "warning",
        amount: `₹${o.pricing.total}`,
        time: "Recently",
      })),
      categoryData: categoryData.map((c, i) => ({
        ...c,
        color: ["#4f46e5", "#10b981", "#f59e0b", "#ef4444"][i % 4],
      })),
      topProducts: topProducts.map((p) => ({
        name: p.name,
        sales: p.sales,
        rev: `₹${p.rev.toFixed(2)}`,
        trend: "+5%",
        cat: "Product",
        icon: "📦",
        color: "bg-blue-50 text-blue-600",
      })),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   PLATFORM SETTINGS (Admin)
================================ */
export const getPlatformSettings = async (req, res) => {
  try {
    let settings = await Setting.findOne({});
    if (!settings) settings = await Setting.create({});
    return handleResponse(res, 200, "Platform settings fetched successfully", settings);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const updatePlatformSettings = async (req, res) => {
  try {
    const payload = req.body || {};
    const settings = await Setting.findOneAndUpdate({}, { $set: payload }, { new: true, upsert: true });
    return handleResponse(res, 200, "Platform settings updated successfully", settings);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET ADMIN PROFILE
================================ */
export const getAdminProfile = async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id);
    if (!admin) return handleResponse(res, 404, "Admin not found");
    return handleResponse(res, 200, "Admin profile fetched successfully", admin);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE ADMIN PROFILE
================================ */
export const updateAdminProfile = async (req, res) => {
  try {
    const { name, email } = req.body;
    const admin = await Admin.findById(req.user.id);
    if (!admin) return handleResponse(res, 404, "Admin not found");
    if (name) admin.name = name;
    if (email) admin.email = email;
    const updatedAdmin = await admin.save();
    return handleResponse(res, 200, "Admin profile updated successfully", updatedAdmin);
  } catch (error) {
    if (error.code === 11000) return handleResponse(res, 400, "Email already in use");
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE ADMIN PASSWORD
================================ */
export const updateAdminPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const admin = await Admin.findById(req.user.id).select("+password");
    if (!admin) return handleResponse(res, 404, "Admin not found");
    const isMatch = await admin.comparePassword(currentPassword);
    if (!isMatch) return handleResponse(res, 401, "Invalid current password");
    admin.password = newPassword;
    await admin.save();
    return handleResponse(res, 200, "Password updated successfully");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET DELIVERY PARTNERS
================================ */
export const getDeliveryPartners = async (req, res) => {
  try {
    const { status, verified } = req.query;
    let query = {};
    if (status === "online") query.isOnline = true;
    else if (status === "offline") query.isOnline = false;
    if (verified === "true") query.isVerified = true;
    else if (verified === "false") query.isVerified = false;

    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const [deliveryPartners, total] = await Promise.all([
      Delivery.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Delivery.countDocuments(query),
    ]);
    return handleResponse(res, 200, "Delivery partners fetched successfully", {
      items: deliveryPartners,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET DELIVERY PARTNER BY ID
================================ */
export const getDeliveryPartnerById = async (req, res) => {
  try {
    const { id } = req.params;
    const rider = await Delivery.findById(id).lean();
    if (!rider) return handleResponse(res, 404, "Delivery Partner not found");

    const recentOrders = await Order.find({ deliveryBoy: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("customer", "name")
      .populate("seller", "shopName")
      .lean();

    const totalOrders = await Order.countDocuments({ deliveryBoy: id, status: "delivered" });

    const earningsAggr = await Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(id), userModel: "Delivery", type: "Delivery Earning" } },
      { $group: { _id: null, totalEarnings: { $sum: "$amount" } } }
    ]);
    const todayAggr = await Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(id), userModel: "Delivery", type: "Delivery Earning", createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } } },
      { $group: { _id: null, todayEarnings: { $sum: "$amount" } } }
    ]);

    const stats = {
      totalOrders,
      totalEarnings: earningsAggr[0]?.totalEarnings || 0,
      todayEarnings: todayAggr[0]?.todayEarnings || 0,
      rating: 4.8
    };

    const activityLogs = await DeliveryActivity.find({ deliveryBoy: id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return handleResponse(res, 200, "Delivery partner details fetched successfully", { rider, recentOrders, stats, activityLogs });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const approveDeliveryPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const rider = await Delivery.findByIdAndUpdate(id, { isVerified: true }, { new: true });
    if (!rider) return handleResponse(res, 404, "Rider not found");
    return handleResponse(res, 200, "Rider approved successfully", rider);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const rejectDeliveryPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const rider = await Delivery.findByIdAndDelete(id);
    if (!rider) return handleResponse(res, 404, "Rider not found");
    return handleResponse(res, 200, "Rider application rejected and removed");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET ACTIVE FLEET
================================ */
export const getActiveFleet = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { deliveryBoy: { $ne: null }, status: { $in: ["confirmed", "packed", "shipped", "out_for_delivery"] } };
    const [activeOrders, total] = await Promise.all([
      Order.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate("deliveryBoy", "name phone documents vehicleType").populate("seller", "shopName address name").populate("customer", "name phone").lean(),
      Order.countDocuments(query),
    ]);
    const fleetData = activeOrders.map((order) => ({
      id: order.orderId,
      status: order.status === "out_for_delivery" ? "On the Way" : order.status === "packed" ? "At Pickup" : order.status === "shipped" ? "In Transit" : "Assigned",
      deliveryBoy: {
        name: order.deliveryBoy?.name || "Unknown",
        phone: order.deliveryBoy?.phone || "N/A",
        id: order.deliveryBoy?._id || "N/A",
        vehicle: order.deliveryBoy?.vehicleType || "N/A",
        image: order.deliveryBoy?.documents?.profileImage || "https://via.placeholder.com/200",
      },
      seller: { name: order.seller?.shopName || order.seller?.name || "Unknown" },
      customer: { name: order.customer?.name || "Guest", phone: order.customer?.phone || "N/A" },
      lastUpdate: order.updatedAt,
    }));
    return handleResponse(res, 200, "Active fleet fetched successfully", { items: fleetData, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   REPORTS (Minimal)
================================ */
export const getReports = async (req, res) => {
  try {
    const { from, to } = req.query || {};
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    const range =
      fromDate instanceof Date &&
      !Number.isNaN(fromDate.getTime()) &&
      toDate instanceof Date &&
      !Number.isNaN(toDate.getTime())
        ? { createdAt: { $gte: fromDate, $lte: toDate } }
        : {};

    const [orderCounts, paymentCounts] = await Promise.all([
      Order.aggregate([
        { $match: range },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: range },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$payment.method", "unknown"] } },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const statusCounts = orderCounts.reduce((acc, row) => {
      acc[String(row._id || "unknown")] = Number(row.count || 0);
      return acc;
    }, {});

    const paymentMethodCounts = paymentCounts.reduce((acc, row) => {
      acc[String(row._id || "unknown")] = Number(row.count || 0);
      return acc;
    }, {});

    return handleResponse(res, 200, "Reports fetched", {
      range: {
        from: fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : null,
        to: toDate && !Number.isNaN(toDate.getTime()) ? toDate : null,
      },
      statusCounts,
      paymentMethodCounts,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET ADMIN WALLET DATA
================================ */
export const getAdminWalletData = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 100 });
    const orderStats = await Order.aggregate([
      { $match: { status: "delivered" } },
      {
        $project: {
          total: "$pricing.total",
          deliveryFee: { $ifNull: ["$pricing.deliveryFee", 0] },
          supplyCost: {
            $reduce: {
              input: "$items",
              initialValue: 0,
              in: { $add: ["$$value", { $multiply: [{ $ifNull: ["$$this.purchasePrice", "$$this.price"] }, "$$this.quantity"] }] }
            }
          }
        }
      },
      { $group: { _id: null, totalPlatformEarning: { $sum: "$total" }, totalAdminEarning: { $sum: { $subtract: ["$total", { $add: ["$deliveryFee", "$supplyCost"] }] } } } }
    ]);
    const stats = orderStats[0] || { totalPlatformEarning: 0, totalAdminEarning: 0 };
    const payoutStats = await Transaction.aggregate([
      { $group: { _id: "$userModel", pendingPayouts: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["Pending", "Processing"]] }, { $gt: ["$amount", 0] }] }, "$amount", 0] } }, systemFloat: { $sum: { $cond: [{ $and: [{ $eq: ["$userModel", "Delivery"] }, { $in: ["$status", ["Pending", "Processing"]] }, { $lt: ["$amount", 0] }] }, "$amount", 0] } } } }
    ]);
    const sellerStats = payoutStats.find((s) => s._id === "Seller") || { pendingPayouts: 0 };
    const deliveryStats = payoutStats.find((s) => s._id === "Delivery") || { pendingPayouts: 0, systemFloat: 0 };
    const [recentTransactions, totalTransactions] = await Promise.all([
      Transaction.find().populate("user", "name shopName").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(),
    ]);
    const transactionItems = recentTransactions.map((t) => ({
      id: (t.reference || t._id).toString(),
      type: t.type,
      amount: t.amount,
      status: t.status,
      sender: t.amount < 0 ? t.user?.name || t.userModel : "System/Order",
      recipient: t.amount > 0 ? t.user?.name || t.userModel : "Platform Wallet",
      date: t.createdAt.toLocaleDateString(),
      time: t.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      notes: t.type,
    }));
    return handleResponse(res, 200, "Admin wallet data fetched", {
      stats: {
        totalPlatformEarning: stats.totalPlatformEarning,
        totalAdminEarning: stats.totalAdminEarning,
        sellerPendingPayouts: sellerStats.pendingPayouts,
        deliveryPendingPayouts: deliveryStats.pendingPayouts,
        systemFloat: Math.abs(deliveryStats.systemFloat),
      },
      transactions: { items: transactionItems, page, limit, total: totalTransactions, totalPages: Math.ceil(totalTransactions / limit) || 1 },
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET DELIVERY TRANSACTIONS
================================ */
export const getDeliveryTransactions = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { userModel: "Delivery" };
    const [transactions, total] = await Promise.all([
      Transaction.find(query).populate("user", "name phone documents").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);
    return handleResponse(res, 200, "Delivery transactions fetched", { items: transactions, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET SELLER TRANSACTIONS
================================ */
export const getSellerTransactions = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { userModel: "Seller" };
    const [transactions, total] = await Promise.all([
      Transaction.find(query).populate("user", "name shopName phone bankDetails").populate({ path: "order", select: "orderId pricing", populate: { path: "items.product", select: "name" } }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);
    return handleResponse(res, 200, "Seller transactions fetched", { items: transactions, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET DELIVERY WITHDRAWALS
================================ */
export const getDeliveryWithdrawals = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { userModel: "Delivery", type: "Withdrawal" };
    const [transactions, total] = await Promise.all([
      Transaction.find(query).populate("user", "name phone").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);
    return handleResponse(res, 200, "Delivery withdrawals fetched", { items: transactions, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET SELLER WITHDRAWALS
================================ */
export const getSellerWithdrawals = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { userModel: "Seller", type: "Withdrawal" };
    const [transactions, total] = await Promise.all([
      Transaction.find(query).populate("user", "name shopName phone").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);
    return handleResponse(res, 200, "Seller withdrawals fetched", { items: transactions, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET PICKUP WITHDRAWALS
================================ */
export const getPickupWithdrawals = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { userModel: "PickupPartner", type: "Withdrawal" };
    const [transactions, total] = await Promise.all([
      Transaction.find(query).populate("user", "name phone").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);
    return handleResponse(res, 200, "Pickup withdrawals fetched", { items: transactions, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE WITHDRAWAL STATUS
================================ */
export const updateWithdrawalStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    if (!["Settled", "Failed", "Processing"].includes(status)) return handleResponse(res, 400, "Invalid status");
    const transaction = await Transaction.findById(id).populate("user", "name");
    if (!transaction) return handleResponse(res, 404, "Transaction not found");
    transaction.status = status;
    if (reason) transaction.notes = reason;
    await transaction.save();
    return handleResponse(res, 200, `Withdrawal ${status} successfully`);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   SETTLE PICKUP PARTNER WALLET
================================ */
export const settlePickupPartnerWallet = async (req, res) => {
  try {
    const { partnerId, amount, paymentMethod, reference } = req.body;
    if (!partnerId || !amount) return handleResponse(res, 400, "Partner ID and Amount are required");

    const partner = await PickupPartner.findById(partnerId);
    if (!partner) return handleResponse(res, 404, "Partner not found");

    if (partner.walletBalance < amount) return handleResponse(res, 400, "Insufficient wallet balance");

    // Deduct from wallet
    partner.walletBalance -= Number(amount);
    await partner.save();

    // Create Transaction Record
    await Transaction.create({
      user: partnerId,
      userModel: "PickupPartner",
      type: "Withdrawal",
      amount: -Number(amount),
      status: "Settled",
      reference: reference || `PAYOUT-${Date.now()}`,
      meta: { paymentMethod }
    });

    return handleResponse(res, 200, "Wallet settled successfully");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   SETTLE TRANSACTION
================================ */
export const settleTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await Transaction.findByIdAndUpdate(id, { status: "Settled" }, { new: true }).populate("user", "name");
    if (!transaction) return handleResponse(res, 404, "Transaction not found");
    await Notification.create({
      recipient: transaction.user._id,
      recipientModel: "Delivery",
      title: "Payment Settled",
      message: `Your payment of ₹${transaction.amount} has been settled.`,
      type: "payment",
      data: { transactionId: transaction._id },
    });
    return handleResponse(res, 200, "Transaction settled successfully", transaction);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   BULK SETTLE DELIVERY
================================ */
export const bulkSettleDelivery = async (req, res) => {
  try {
    const result = await Transaction.updateMany({ userModel: "Delivery", status: "Pending" }, { status: "Settled" });
    return handleResponse(res, 200, `${result.modifiedCount} transactions settled successfully`);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET DELIVERY CASH BALANCES
================================ */
export const getDeliveryCashBalances = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const ridersPipeline = [
      { $lookup: { from: "transactions", localField: "_id", foreignField: "user", as: "allTransactions" } },
      { $lookup: { from: "orders", localField: "_id", foreignField: "deliveryBoy", as: "allOrders" } },
      {
        $project: {
          name: 1, phone: 1, avatar: 1, limit: { $ifNull: ["$limit", 5000] }, documents: 1,
          currentCash: { $reduce: { input: { $filter: { input: "$allTransactions", as: "t", cond: { $in: ["$$t.type", ["Cash Collection", "Cash Settlement"]] } } }, initialValue: 0, in: { $cond: [{ $eq: ["$$this.type", "Cash Collection"] }, { $add: ["$$value", "$$this.amount"] }, { $subtract: ["$$value", { $abs: "$$this.amount" }] }] } } },
          pendingOrders: { $size: { $filter: { input: "$allOrders", as: "o", cond: { $and: [{ $in: ["$$o.status", ["confirmed", "packed", "picked_up", "out_for_delivery"]] }, { $in: ["$$o.payment.method", ["cash", "cod"]] }] } } } },
          totalOrders: { $size: { $filter: { input: "$allOrders", as: "o", cond: { $eq: ["$$o.status", "delivered"] } } } },
          lastSettlementTxn: { $arrayElemAt: [{ $sortArray: { input: { $filter: { input: "$allTransactions", as: "t", cond: { $eq: ["$$t.type", "Cash Settlement"] } } }, sortBy: { createdAt: -1 } } }, 0] },
        }
      },
      {
        $project: {
          id: "$_id", name: 1, phone: 1, currentCash: 1, limit: 1, pendingOrders: 1, totalOrders: 1,
          avatar: { $cond: [{ $ifNull: ["$documents.profileImage", false] }, "$documents.profileImage", { $concat: ["https://api.dicebear.com/7.x/avataaars/svg?seed=", "$name"] }] },
          status: { $cond: [{ $gt: ["$currentCash", 4500] }, "critical", { $cond: [{ $gt: ["$currentCash", 3000] }, "warning", "safe"] }] },
          lastSettlement: { $ifNull: ["$lastSettlementTxn.createdAt", "Never"] },
        }
      },
      { $facet: { meta: [{ $count: "total" }], items: [{ $skip: skip }, { $limit: limit }] } }
    ];

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [aggregateResult, todayCollectedRes] = await Promise.all([
      Delivery.aggregate(ridersPipeline),
      Transaction.aggregate([
        { $match: { type: "Cash Collection", createdAt: { $gte: startOfToday } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
    ]);

    const meta = aggregateResult?.[0]?.meta?.[0];
    const riders = aggregateResult?.[0]?.items ?? [];
    const total = meta?.total ?? 0;
    const collectedToday = todayCollectedRes[0]?.total || 0;

    const totalInHand = riders.reduce((acc, r) => acc + (r.currentCash || 0), 0);
    const overLimitCount = riders.filter((r) => (r.currentCash || 0) >= (r.limit || 5000)).length;

    return handleResponse(res, 200, "Cash balances fetched", {
      items: riders, page, limit, total, totalPages: Math.ceil(total / limit) || 1,
      stats: { totalInHand, overLimitCount, collectedToday, avgBalance: riders.length ? totalInHand / riders.length : 0 },
    });
  } catch (error) {
    console.error("Aggregation Error:", error);
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   SETTLE RIDER CASH (Admin)
================================ */
export const settleRiderCash = async (req, res) => {
  try {
    const { riderId, amount, method } = req.body;
    if (!riderId || !amount || amount <= 0) return handleResponse(res, 400, "Missing riderId or invalid amount");
    const rider = await Delivery.findById(riderId);
    if (!rider) return handleResponse(res, 404, "Rider not found");
    const settlement = await Transaction.create({ user: riderId, userModel: "Delivery", type: "Cash Settlement", amount: -Math.abs(amount), status: "Settled", reference: `CSH-SET-${Date.now()}`, notes: `Method: ${method || "Cash"}` });
    await Notification.create({ recipient: riderId, recipientModel: "Delivery", title: "Cash Settled", message: `Admin has collected ₹${amount} cash from you. Your balance is updated.`, type: "payment", data: { transactionId: settlement._id } });
    return handleResponse(res, 201, "Cash settled successfully", settlement);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET RIDER CASH DETAILS
================================ */
export const getRiderCashDetails = async (req, res) => {
  try {
    const { id: riderId } = req.params;
    const transactions = await Transaction.find({ user: riderId, userModel: "Delivery", type: "Cash Collection" }).populate("order", "orderId pricing createdAt").sort({ createdAt: -1 }).limit(20);
    const formatted = transactions.map((t) => ({ id: t.order?.orderId || t.reference || "N/A", amount: t.amount, time: new Date(t.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), date: t.createdAt }));
    return handleResponse(res, 200, "Rider cash details fetched", formatted);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET CASH SETTLEMENT HISTORY
================================ */
export const getCashSettlementHistory = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const query = { userModel: "Delivery", type: "Cash Settlement" };
    const [history, total] = await Promise.all([
      Transaction.find(query).populate("user", "name").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);
    const mappedHistory = history.map((h) => ({ id: (h.reference || h._id).toString(), rider: h.user?.name || "Unknown Rider", amount: Math.abs(h.amount), date: h.createdAt, method: h.notes?.replace("Method: ", "") || "Cash Submission", status: "completed" }));
    return handleResponse(res, 200, "Settlement history fetched", { items: mappedHistory, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET ALL CUSTOMERS
================================ */
export const getUsers = async (req, res) => {
  try {
    const roleMatch = { $in: ["user", "customer"] };
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const pipeline = [
      { $match: { role: roleMatch } },
      { $lookup: { from: "orders", localField: "_id", foreignField: "customer", as: "userOrders" } },
      { $project: { id: { $toString: "$_id" }, name: { $ifNull: ["$name", "Unnamed Customer"] }, businessName: { $ifNull: ["$businessName", ""] }, contactPerson: { $ifNull: ["$contactPerson", ""] }, email: 1, phone: 1, joinedDate: "$createdAt", status: { $cond: [{ $eq: ["$isActive", false] }, "inactive", "active"] }, totalOrders: { $size: "$userOrders" }, totalSpent: { $sum: "$userOrders.pricing.total" }, lastOrderDate: { $max: "$userOrders.createdAt" }, codBlocked: { $ifNull: ["$codBlocked", false] }, codCancelCount: { $ifNull: ["$codCancelCount", 0] }, codBlockedAt: 1, avatar: customerAvatarProjection } },
      { $sort: { totalOrders: -1 } },
    ];
    const [result] = await User.aggregate([...pipeline, { $facet: { totalCount: [{ $count: "count" }], items: [{ $skip: skip }, { $limit: limit }] } }]);
    const total = result?.totalCount?.[0]?.count ?? 0;
    const items = result?.items ?? [];
    return handleResponse(res, 200, "Users fetched successfully", { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET USER BY ID
================================ */
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id), role: { $in: ["user", "customer"] } } },
      { $lookup: { from: "orders", localField: "_id", foreignField: "customer", as: "userOrders" } },
      { $project: { id: { $toString: "$_id" }, name: { $ifNull: ["$name", "Unnamed Customer"] }, businessName: { $ifNull: ["$businessName", ""] }, contactPerson: { $ifNull: ["$contactPerson", ""] }, email: 1, phone: 1, joinedDate: "$createdAt", status: { $cond: [{ $eq: ["$isActive", false] }, "inactive", "active"] }, totalOrders: { $size: "$userOrders" }, totalSpent: { $sum: "$userOrders.pricing.total" }, lastOrderDate: { $max: "$userOrders.createdAt" }, avatar: customerAvatarProjection, addresses: { $ifNull: ["$addresses", []] }, codBlocked: { $ifNull: ["$codBlocked", false] }, codCancelCount: { $ifNull: ["$codCancelCount", 0] }, codBlockedAt: 1 } },
    ]);
    if (!user || user.length === 0) return handleResponse(res, 404, "Customer not found");
    const recentOrders = await Order.find({ customer: id }).sort({ createdAt: -1 }).limit(10).populate("items.product", "name mainImage");
    const u = user[0];
    const responseData = { ...u, addresses: Array.isArray(u.addresses) ? u.addresses : [], recentOrders: recentOrders.map((o) => ({ id: o.orderId, _id: o._id, itemsCount: o.items.length, amount: o.pricing.total, date: o.createdAt, status: o.status })) };
    return handleResponse(res, 200, "Customer details fetched successfully", responseData);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE CUSTOMER ACTIVE STATUS (admin block / unblock)
================================ */
export const updateCustomerAccountStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return handleResponse(res, 400, "Invalid customer id");
    }
    if (typeof isActive !== "boolean") {
      return handleResponse(res, 400, "isActive (boolean) is required");
    }

    const customer = await User.findOne({
      _id: id,
      role: { $in: ["user", "customer"] },
    });

    if (!customer) {
      return handleResponse(res, 404, "Customer not found");
    }

    customer.isActive = isActive;
    await customer.save();

    return handleResponse(res, 200, isActive ? "Customer activated" : "Customer suspended", {
      id: customer._id.toString(),
      isActive: customer.isActive,
      status: customer.isActive ? "active" : "inactive",
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET ALL SELLERS
================================ */
export const getSellers = async (req, res) => {
  try {
    const { verified } = req.query;
    let query = {};
    if (verified === "true" || verified === true) query.isVerified = true;
    else if (verified === "false" || verified === false) query.isVerified = false;
    const sellers = await Seller.find(query).select("-password -__v").sort({ createdAt: -1 }).lean();
    return handleResponse(res, 200, "Sellers fetched", { items: sellers, total: sellers.length });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET SELLER BY ID
================================ */
export const getSellerById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return handleResponse(res, 400, "Invalid seller ID");
    const seller = await Seller.findById(id).lean();
    if (!seller) return handleResponse(res, 404, "Seller not found");
    const [totalOrders, totalRevenue, recentOrders] = await Promise.all([
      Order.countDocuments({ seller: id }),
      Order.aggregate([{ $match: { seller: new mongoose.Types.ObjectId(id), status: "delivered" } }, { $group: { _id: null, total: { $sum: "$pricing.total" } } }]),
      Order.find({ seller: id }).sort({ createdAt: -1 }).limit(10).populate("customer", "name phone")
    ]);
    const stats = { totalOrders, totalRevenue: totalRevenue[0]?.total || 0, recentOrders: recentOrders.map(o => ({ id: o.orderId, customer: o.customer?.name || "Guest", status: o.status, amount: o.pricing.total, date: o.createdAt })) };
    return handleResponse(res, 200, "Seller details fetched", { ...seller, stats });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET COD CUSTOMERS
================================ */
export const getCodCustomers = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all").toLowerCase();
    const match = { role: { $in: ["user", "customer"] } };
    if (status === "blocked") match.codBlocked = true;
    else if (status === "eligible") match.codBlocked = { $ne: true };
    if (search) match.$or = [{ name: { $regex: search, $options: "i" } }, { email: { $regex: search, $options: "i" } }, { phone: { $regex: search, $options: "i" } }, { businessName: { $regex: search, $options: "i" } }];
    const [items, total] = await Promise.all([User.find(match).select("_id name businessName contactPerson email phone isActive codBlocked codCancelCount codBlockedAt createdAt").sort({ codBlocked: -1, codCancelCount: -1, createdAt: -1 }).skip(skip).limit(limit).lean(), User.countDocuments(match)]);
    return handleResponse(res, 200, "COD customers fetched", { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE CUSTOMER COD POLICY
================================ */
export const updateCustomerCodPolicy = async (req, res) => {
  try {
    const { id } = req.params;
    const { codBlocked, resetCancelCount, codCancelCount } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return handleResponse(res, 400, "Invalid customer id");
    const customer = await User.findById(id);
    if (!customer || !["user", "customer"].includes(String(customer.role || ""))) return handleResponse(res, 404, "Customer not found");
    if (typeof codBlocked === "boolean") { customer.codBlocked = codBlocked; customer.codBlockedAt = codBlocked ? new Date() : null; }
    if (resetCancelCount === true) customer.codCancelCount = 0;
    if (codCancelCount !== undefined && Number.isFinite(Number(codCancelCount))) customer.codCancelCount = Math.max(0, Math.floor(Number(codCancelCount)));
    await customer.save();
    return handleResponse(res, 200, "Customer COD policy updated", { _id: customer._id, codBlocked: customer.codBlocked, codCancelCount: customer.codCancelCount, codBlockedAt: customer.codBlockedAt || null });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   CREATE SELLER (Admin)
================================ */
export const createSellerByAdmin = async (req, res) => {
  try {
    const { name, shopName, address, email, phone, password, lat, lng, radius, isVerified, isActive } = req.body;
    if (!name || !shopName || !email || !phone || !password) return handleResponse(res, 400, "name, shopName, email, phone and password are required");
    const existing = await Seller.findOne({ $or: [{ email }, { phone }] }).lean();
    if (existing) return handleResponse(res, 400, "Seller with this email or phone already exists");
    const sellerData = { name: String(name).trim(), shopName: String(shopName).trim(), address: address || "", email: String(email).trim().toLowerCase(), phone: String(phone).trim(), password: String(password), isVerified: typeof isVerified === "boolean" ? isVerified : true, isActive: typeof isActive === "boolean" ? isActive : true };
    if (lat !== undefined && lng !== undefined) {
      const parsedLat = Number(lat); const parsedLng = Number(lng);
      if (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) return handleResponse(res, 400, "Invalid latitude");
      if (!Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180) return handleResponse(res, 400, "Invalid longitude");
      sellerData.location = { type: "Point", coordinates: [parsedLng, parsedLat] };
    }
    if (radius !== undefined) {
      const parsedRadius = Number(radius);
      if (!Number.isFinite(parsedRadius) || parsedRadius < 1 || parsedRadius > 100) return handleResponse(res, 400, "Radius must be between 1 and 100 km");
      sellerData.serviceRadius = parsedRadius;
    }
    const seller = await Seller.create(sellerData);
    return handleResponse(res, 201, "Seller created successfully", seller);
  } catch (error) {
    if (error?.code === 11000) return handleResponse(res, 400, "Email or phone already in use");
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE SELLER (Admin)
================================ */
export const updateSellerByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, shopName, address, email, phone, password, lat, lng, radius, isVerified, isActive } = req.body;
    const seller = await Seller.findById(id);
    if (!seller) return handleResponse(res, 404, "Seller not found");
    if (name !== undefined) seller.name = String(name).trim();
    if (shopName !== undefined) seller.shopName = String(shopName).trim();
    if (address !== undefined) seller.address = String(address).trim();
    if (email !== undefined) seller.email = String(email).trim().toLowerCase();
    if (phone !== undefined) seller.phone = String(phone).trim();
    if (password !== undefined && String(password).trim()) seller.password = String(password);
    if (typeof isVerified === "boolean") seller.isVerified = isVerified;
    if (typeof isActive === "boolean") seller.isActive = isActive;
    if (lat !== undefined && lng !== undefined) {
      const parsedLat = Number(lat); const parsedLng = Number(lng);
      if (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) return handleResponse(res, 400, "Invalid latitude");
      if (!Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180) return handleResponse(res, 400, "Invalid longitude");
      seller.location = { type: "Point", coordinates: [parsedLng, parsedLat] };
    }
    if (radius !== undefined) {
      const parsedRadius = Number(radius);
      if (!Number.isFinite(parsedRadius) || parsedRadius < 1 || parsedRadius > 100) return handleResponse(res, 400, "Radius must be between 1 and 100 km");
      seller.serviceRadius = parsedRadius;
    }
    const updated = await seller.save();
    return handleResponse(res, 200, "Seller updated successfully", updated);
  } catch (error) {
    if (error?.code === 11000) return handleResponse(res, 400, "Email or phone already in use");
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   APPROVE SELLER (Admin)
================================ */
export const approveSeller = async (req, res) => {
  try {
    const { id } = req.params;
    const seller = await Seller.findByIdAndUpdate(id, { isVerified: true, isActive: true }, { new: true });
    if (!seller) return handleResponse(res, 404, "Seller not found");
    return handleResponse(res, 200, "Seller approved successfully", seller);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   REJECT SELLER (Admin)
================================ */
export const rejectSeller = async (req, res) => {
  try {
    const { id } = req.params;
    const [seller] = await Promise.all([Seller.findByIdAndDelete(id), Product.deleteMany({ sellerId: id }), PurchaseRequest.deleteMany({ sellerId: id })]);
    if (!seller) return handleResponse(res, 404, "Seller not found");
    return handleResponse(res, 200, "Application rejected and all related data removed");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
