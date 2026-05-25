import Order from "../models/order.js";
import User from "../models/customer.js";
import Setting from "../models/setting.js";
import Transaction from "../models/transaction.js";
import { WORKFLOW_STATUS } from "../constants/orderWorkflow.js";

const COD_METHODS = new Set(["cash", "cod"]);

export const normalizePaymentMethod = (method) =>
  String(method || "cash")
    .trim()
    .toLowerCase();

export const isCodMethod = (method) => COD_METHODS.has(normalizePaymentMethod(method));

export const getCodBlockThreshold = async () => {
  try {
    const settings = await Setting.findOne({})
      .select("codCancelBlockThreshold")
      .lean();
    const fromSettings = Number(settings?.codCancelBlockThreshold);
    if (Number.isFinite(fromSettings) && fromSettings >= 1) {
      return Math.floor(fromSettings);
    }
  } catch {
    return 3;
  }
  return 3;
};

export const applyCodCancellationStrike = async (customerId) => {
  const customer = await User.findById(customerId);
  if (!customer) return null;
  const threshold = await getCodBlockThreshold();
  const nextCount = Number(customer.codCancelCount || 0) + 1;
  customer.codCancelCount = nextCount;
  if (nextCount >= threshold && !customer.codBlocked) {
    customer.codBlocked = true;
    customer.codBlockedAt = new Date();
  }
  await customer.save();
  return customer;
};

/**
 * Service to manage overall order lifecycle.
 */

export const getOrderById = async (orderId) => {
  return await Order.findOne({ orderId }).populate("customer seller deliveryBoy");
};

export const createOrder = async (orderData) => {
  const order = new Order(orderData);
  return await order.save();
};

export const updateOrderStatus = async (orderId, statusData) => {
  return await Order.findOneAndUpdate(
    { orderId },
    { $set: statusData },
    { new: true }
  );
};

export const getCustomerOrders = async (customerId) => {
  return await Order.find({ customer: customerId }).sort({ createdAt: -1 });
};
