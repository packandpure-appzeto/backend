import Order from "../models/order.js";
import mongoose from "mongoose";
import Cart from "../models/cart.js";
import Product from "../models/product.js";
import HubInventory from "../models/hubInventory.js";
import Transaction from "../models/transaction.js";
import StockHistory from "../models/stockHistory.js";
import Notification from "../models/notification.js";
import { createNotification } from "../services/notificationService.js";
import Seller from "../models/seller.js";
import PurchaseRequest from "../models/purchaseRequest.js";
import Delivery from "../models/delivery.js";
import Admin from "../models/admin.js";
import Setting from "../models/setting.js";
import User from "../models/customer.js";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import { WORKFLOW_STATUS } from "../constants/orderWorkflow.js";
import {
  sellerAcceptAtomic,
  sellerRejectAtomic,
  deliveryAcceptAtomic,
  customerCancelV2,
  startHubDeliverySearchAtomic,
  resolveWorkflowStatus,
} from "../services/orderWorkflowService.js";
import { applyCodCancellationStrike, isCodMethod, normalizePaymentMethod } from "../services/orderService.js";
import {
  planHubFulfillment,
  reserveHubInventory,
  createAutoPurchaseRequests,
} from "../services/hubOrderOrchestrator.js";
import { emitToAdminOrdersRoom, emitToSeller } from "../services/orderSocketEmitter.js";
import { distanceMeters } from "../utils/geoUtils.js";
import { calculateDeliveryFee } from "../utils/deliveryFeeUtil.js";
import {
  orderMatchQueryFromRouteParam,
  orderMatchQueryFlexible,
} from "../utils/orderLookup.js";
import {
  ORDER_ITEM_PRODUCT_POPULATE,
  enrichOrderDoc,
  findOrderVariant,
  formatOrderVariantSlot,
  resolveOrderItemPrice,
} from "../utils/orderItemHelpers.js";
import { resolveVariantIndex } from "../utils/productHelpers.js";

// COD strike logic now handled in orderService.js

const ORDER_CART_POPULATE =
  "name slug price salePrice purchasePrice mainImage stock gstRate unit variants";

async function reverseOrderItemStock(item, order) {
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) return;

  const productId = item.product?._id || item.product;
  if (!productId) return;

  if (item.variantId) {
    const product = await Product.findById(productId)
      .select("variants sellerId")
      .lean();
    const idx = resolveVariantIndex(product, { variantId: item.variantId });
    if (idx >= 0) {
      await Product.updateOne(
        { _id: productId },
        {
          $inc: {
            [`variants.${idx}.stock`]: qty,
            stock: qty,
          },
        },
      );
    } else {
      await Product.findByIdAndUpdate(productId, { $inc: { stock: qty } });
    }
  } else {
    await Product.findByIdAndUpdate(productId, { $inc: { stock: qty } });
  }

  await StockHistory.create({
    product: productId,
    seller: order.seller,
    type: "Correction",
    quantity: qty,
    note: `Order #${order.orderId} Cancelled`,
    order: order._id,
    variantId: item.variantId || undefined,
  });
}

/* ===============================
   PLACE ORDER
================================ */
export const getDeliveryFee = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return handleResponse(res, 400, "Coordinates required");
    }
    const pricing = await calculateDeliveryFee({ lat: Number(lat), lng: Number(lng) });
    return handleResponse(res, 200, "Delivery fee calculated", pricing);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const placeOrder = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { address, payment, pricing, timeSlot, items, promotionId } = req.body;
    const paymentMethod = normalizePaymentMethod(payment?.method);
    const customer = await User.findById(customerId).select(
      "walletBalance codBlocked codCancelCount",
    );

    if (!customer) {
      return handleResponse(res, 404, "Customer not found");
    }
    if (isCodMethod(paymentMethod) && customer.codBlocked) {
      return handleResponse(
        res,
        400,
        "Cash on Delivery is disabled for your account. Please use online or wallet payment.",
      );
    }
    if (
      paymentMethod === "wallet" &&
      Number(customer.walletBalance || 0) < Number(pricing?.total || 0)
    ) {
      return handleResponse(res, 400, "Insufficient wallet balance");
    }

    // 1. Generate unique Order ID
    const orderId = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // 2. Map items if provided, or fetch from cart if not
    let orderItems = items;
    if (!orderItems || orderItems.length === 0) {
      const cart = await Cart.findOne({ customerId }).populate(
        "items.productId",
        ORDER_CART_POPULATE,
      );
      if (!cart || cart.items.length === 0) {
        return handleResponse(res, 400, "Cannot place order with empty cart");
      }
      orderItems = cart.items.map((item) => {
        const product = item.productId;
        const variant = item.variantId
          ? findOrderVariant(product, item.variantId)
          : null;
        return {
          product: product._id,
          name: product.name,
          quantity: item.quantity,
          price: resolveOrderItemPrice(product, variant),
          purchasePrice: product.purchasePrice || 0,
          image: product.mainImage,
          variantId: item.variantId || undefined,
          variantSlot: formatOrderVariantSlot(variant, product),
        };
      });
    }

    // 3. Normalize address.location so only valid numeric coords are stored
    let normalizedAddress = { ...address };
    if (address?.location) {
      const { lat, lng } = address.location;
      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
      ) {
        normalizedAddress = { ...address, location: undefined };
      }
    }

    // Normalize/resolve product references so downstream hub/vendor mapping is reliable.
    if (Array.isArray(orderItems) && orderItems.length > 0) {
      const normalizedItems = [];
      for (const item of orderItems) {
        let candidate =
          item?.product?._id ||
          item?.productId?._id ||
          item?.product ||
          item?.productId ||
          item?._id ||
          item?.id;
        if (candidate && typeof candidate === "object" && candidate._id) {
          candidate = candidate._id;
        }

        let resolvedProductId =
          candidate && mongoose.Types.ObjectId.isValid(String(candidate))
            ? String(candidate)
            : null;

        if (!resolvedProductId) {
          const fallbackQuery = [];
          if (item?.sku && typeof item.sku === "string") {
            fallbackQuery.push({ sku: item.sku.trim() });
          }
          if (item?.slug && typeof item.slug === "string") {
            fallbackQuery.push({ slug: item.slug.trim().toLowerCase() });
          }
          if (item?.name && typeof item.name === "string") {
            fallbackQuery.push({ name: item.name.trim() });
          }
          if (fallbackQuery.length) {
            // eslint-disable-next-line no-await-in-loop
            const found = await Product.findOne({ $or: fallbackQuery })
              .select("_id")
              .lean();
            if (found?._id) resolvedProductId = String(found._id);
          }
        }

        if (!resolvedProductId) {
          return handleResponse(
            res,
            400,
            `Invalid product reference in checkout item: ${item?.name || "Unknown item"}`,
          );
        }

        // Always fetch the latest product data to ensure pricing/purchasePrice integrity
        const productData = await Product.findById(resolvedProductId)
          .select("_id purchasePrice salePrice price gstRate variants unit mainImage name")
          .lean();

        if (!productData) {
          return handleResponse(res, 400, `Product not found: ${item?.name || resolvedProductId}`);
        }

        const variantId = item.variantId || null;
        const variant = variantId
          ? findOrderVariant(productData, variantId)
          : null;

        normalizedItems.push({
          ...item,
          product: String(productData._id),
          name: item.name || productData.name,
          purchasePrice: productData.purchasePrice || 0,
          price: resolveOrderItemPrice(productData, variant, item.price),
          gstRate: productData.gstRate || 0,
          image: item.image || productData.mainImage,
          variantId: variantId || undefined,
          variantSlot:
            item.variantSlot || formatOrderVariantSlot(variant, productData),
        });
      }
      orderItems = normalizedItems;
    }

    const defaultSlaHours = parseInt(process.env.HUB_SLA_HOURS || "3", 10);
    const slaDeadlineAt = new Date(
      Date.now() + Math.max(1, defaultSlaHours) * 60 * 60 * 1000,
    );

    // Validate Pricing (Tamper prevention)
    let validatedPricing = { ...pricing };
    if (normalizedAddress?.location) {
      const calc = await calculateDeliveryFee(normalizedAddress.location);
      
      if (calc.isOutOfRange) {
        return handleResponse(res, 400, `Address is outside our delivery range (${calc.maxServiceRadius}km)`);
      }

      // Distance-based delivery fee
      validatedPricing.deliveryFee = calc.deliveryFee;
      validatedPricing.distanceKm = calc.distanceKm;
      validatedPricing.platformFee = calc.platformFee;

      // Free delivery: if subtotal >= threshold, waive the delivery fee
      if ((validatedPricing.subtotal || 0) >= calc.freeDeliveryThreshold) {
        validatedPricing.deliveryFee = 0;
      }

      // GST on (Subtotal - Discount + Delivery + Platform)
      let totalItemGst = 0;
      const subtotal = validatedPricing.subtotal || 0;
      const discount = validatedPricing.discount || 0;
      
      orderItems = orderItems.map(item => {
        const itemTotal = (item.price || 0) * (item.quantity || 0);
        const discountShare = subtotal > 0 ? (itemTotal / subtotal) * discount : 0;
        const itemTaxableAmount = Math.max(0, itemTotal - discountShare);
        const rate = Number(item.gstRate || 0);
        const amount = Math.round(itemTaxableAmount * (rate / 100));
        totalItemGst += amount;
        return { ...item, gstRate: rate, gstAmount: amount };
      });

      // GST on Services (Removed Global Fallback - Defaulting to 0% for fees)
      const serviceGst = 0;
      validatedPricing.gst = totalItemGst + serviceGst;

      // Final Total Recalculation
      validatedPricing.total = (validatedPricing.subtotal || 0) 
        - (validatedPricing.discount || 0)
        + validatedPricing.deliveryFee 
        + validatedPricing.platformFee
        + validatedPricing.gst 
        + (validatedPricing.tip || 0);
    }

    let newOrder = null;
    let hubMeta = null;

    const hubPlan = await planHubFulfillment(orderItems);
    const hubStatus = hubPlan.fullyAvailable
      ? "inventory_reserved"
      : "procurement_required";

    newOrder = new Order({
      orderId,
      customer: customerId,
      seller: null,
      items: orderItems,
      address: normalizedAddress,
      payment: {
        ...payment,
        method: paymentMethod,
      },
      pricing: validatedPricing,
      timeSlot: timeSlot || "now",
      status: "pending",
      workflowVersion: 2,
      workflowStatus: WORKFLOW_STATUS.CREATED,
      supplyChainStatus: hubPlan.fullyAvailable ? "READY_FOR_DELIVERY" : "WAITING_VENDOR",
      hubFlowEnabled: true,
      hubId: hubPlan.hubId,
      hubStatus,
      procurementRequired: !hubPlan.fullyAvailable,
      slaDeadlineAt,
      promotionApplied: promotionId || null,
    });
    await newOrder.save();

    if (promotionId) {
      // Import Promotion model at top of file, or just use mongoose.model
      await mongoose.model("Promotion").findByIdAndUpdate(promotionId, { $inc: { usedCount: 1 } });
    }

    // Reserve whatever hub stock is currently available (full or partial).
    const reserveResult = await reserveHubInventory(hubPlan.allocations, hubPlan.hubId);
    const finalPlan = reserveResult.ok
      ? hubPlan
      : await planHubFulfillment(orderItems, hubPlan.hubId);

    let purchaseRequests = [];
    try {
      purchaseRequests = finalPlan.shortages.length
        ? await createAutoPurchaseRequests({
            order: newOrder,
            shortages: finalPlan.shortages,
            hubId: finalPlan.hubId,
          })
        : [];
    } catch (procurementErr) {
      // Roll back any hub reservations and abort the order when procurement is impossible.
      if (reserveResult.ok && Array.isArray(reserveResult.reservedRows)) {
        for (const applied of reserveResult.reservedRows) {
          // Best-effort rollback; do not throw if rollback fails.
          // eslint-disable-next-line no-await-in-loop
          await HubInventory.findOneAndUpdate(
            { hubId: hubPlan.hubId, productId: applied.productId },
            { $inc: { availableQty: applied.reserveQty, reservedQty: -applied.reserveQty } },
          );
          // eslint-disable-next-line no-await-in-loop
          await Product.findByIdAndUpdate(applied.productId, { $inc: { stock: applied.reserveQty } });
        }
      }

      await Order.deleteOne({ _id: newOrder._id });
      return handleResponse(res, 400, procurementErr.message || "Unable to procure items for this order.");
    }

    if (finalPlan.shortages.length === 0) {
      try {
        await startHubDeliverySearchAtomic(orderId);
      } catch (e) {
        console.warn(
          `[placeOrder] delivery dispatch skipped for ${orderId}: ${e.message}`,
        );
      }
    }

    if (purchaseRequests.length > 0) {
      await Promise.all(
        purchaseRequests.map((pr) => {
          if (!pr.vendorId) return null;
          
          // Real-time socket notification for Procurement Requests
          emitToSeller(pr.vendorId.toString(), {
            event: "purchase_request:new",
            payload: {
              orderId,
              purchaseRequestId: pr._id?.toString(),
              itemsCount: pr.items?.length || 0,
              totalAmount: pricing?.total || 0
            }
          });

          return createNotification({
            recipient: pr.vendorId,
            recipientModel: "Seller",
            title: "Vendor Purchase Request",
            message: `A purchase request has been created for order #${orderId}.`,
            type: "order",
            data: { orderId, purchaseRequestId: pr._id?.toString() },
          });
        }),
      );
    }

    newOrder.hubStatus =
      finalPlan.shortages.length > 0 ? "procurement_required" : "inventory_reserved";
    newOrder.procurementRequired = finalPlan.shortages.length > 0;
    await newOrder.save();

    await createNotification({
      recipient: customerId,
      recipientModel: "Customer",
      title: "Order Placed",
      message: `Your order #${orderId} has been placed successfully.`,
      type: "order",
      data: { orderId, mongoOrderId: newOrder._id },
    });

    if (paymentMethod === "wallet") {
      const debitAmount = Number(validatedPricing?.total || pricing?.total || 0);
      customer.walletBalance = Math.max(0, Number(customer.walletBalance || 0) - debitAmount);
      await customer.save();
      await Transaction.create({
        user: customer._id,
        userModel: "User",
        order: newOrder._id,
        type: "Order Payment",
        amount: -Math.abs(debitAmount),
        status: "Settled",
        reference: `WALLET-DEBIT-${orderId}`,
      });
    }

    hubMeta = {
      mode: "hub_first",
      hubStatus: newOrder.hubStatus,
      purchaseRequestsCreated: purchaseRequests.length,
      unassignedProcurementItems: finalPlan.shortages.filter((s) => !s.vendorId).length,
    };

    // SOP flow: if hub can fully fulfill, dispatch to delivery search immediately.
    let orderForResponse = newOrder;
    if (finalPlan.shortages.length === 0) {
      try {
        const dispatched = await startHubDeliverySearchAtomic(newOrder.orderId);
        if (dispatched) {
          orderForResponse = dispatched;
          hubMeta.autoDispatched = true;
          hubMeta.dispatchWorkflowStatus = dispatched.workflowStatus;
        } else {
          hubMeta.autoDispatched = false;
        }
      } catch (dispatchErr) {
        console.warn(
          `[placeOrder] auto dispatch failed for ${newOrder.orderId}:`,
          dispatchErr.message,
        );
        hubMeta.autoDispatched = false;
        hubMeta.dispatchError = dispatchErr.message;
      }
    } else {
      hubMeta.autoDispatched = false;
    }

    // Notify admin users about new order for hub-first operations.
    try {
      const admins = await Admin.find({}).select("_id").lean();
      const adminIds = admins.map((a) => a?._id).filter(Boolean);
      if (adminIds.length) {
        await Notification.insertMany(
          adminIds.map((adminId) => ({
            recipient: adminId,
            recipientModel: "Admin",
            title: "New Order Received",
            message: `Order #${orderId} received and routed to hub workflow.`,
            type: "order",
            data: {
              orderId: orderForResponse.orderId,
              mongoOrderId: orderForResponse._id,
              hubStatus: orderForResponse.hubStatus,
              procurementRequired: orderForResponse.procurementRequired,
              totalAmount: pricing?.total ?? 0,
              autoDispatched: hubMeta.autoDispatched,
            },
          })),
          { ordered: false },
        );
      }
      emitToAdminOrdersRoom({
        event: "order:new:admin",
        payload: {
          orderId: orderForResponse.orderId,
          mongoOrderId: orderForResponse._id,
          hubStatus: orderForResponse.hubStatus,
          procurementRequired: orderForResponse.procurementRequired,
          totalAmount: pricing?.total ?? 0,
          autoDispatched: hubMeta.autoDispatched,
        },
      });
    } catch (notifyErr) {
      console.warn("[placeOrder] admin notify failed:", notifyErr.message);
    }

    // 6. Clear the customer's cart after order is placed
    await Cart.findOneAndUpdate({ customerId }, { items: [] });

    return handleResponse(res, 201, "Order placed successfully", {
      ...(orderForResponse?.toObject ? orderForResponse.toObject() : orderForResponse),
      hubMeta,
    });
  } catch (error) {
    console.error("Place Order Error:", error);
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET CUSTOMER ORDERS
================================ */
export const getMyOrders = async (req, res) => {
  try {
    const customerId = req.user.id;
    const orders = await Order.find({ customer: customerId })
      .select(
        "orderId customer seller items address payment pricing status workflowStatus workflowVersion returnStatus timeSlot createdAt",
      )
      .sort({ createdAt: -1 })
      .populate("items.product", ORDER_ITEM_PRODUCT_POPULATE)
      .lean();

    return handleResponse(
      res,
      200,
      "Orders fetched successfully",
      orders.map((o) => enrichOrderDoc(o)),
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET SELLER RETURNS (Admin/Seller)
================================ */
export const getSellerReturns = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { status, startDate, endDate } = req.query;

    const query = {};

    if (role !== "admin") {
      query.seller = userId;
    }

    query.returnStatus = { $ne: "none" };

    if (status && status !== "all") {
      query.returnStatus = status;
    }

    if (startDate || endDate) {
      query.returnRequestedAt = {};
      if (startDate) {
        query.returnRequestedAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.returnRequestedAt.$lte = end;
      }
    }

    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 100,
    });

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort({ returnRequestedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("customer", "name phone")
        .populate("returnDeliveryBoy", "name phone")
        .lean(),
      Order.countDocuments(query),
    ]);

    return handleResponse(res, 200, "Seller returns fetched", {
      items: orders,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Populated ref `{ _id, ... }` or raw ObjectId string — safe id string for ACL checks */
function refToIdString(ref) {
  if (ref == null) return "";
  if (typeof ref === "object" && ref._id != null) return String(ref._id);
  return String(ref);
}

/* ===============================
   GET ORDER DETAILS
================================ */
export const getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { role } = req.user;
    const userId = req.user?.id ?? req.user?._id;
    const uid = userId != null ? String(userId).trim() : "";

    const orderKey = orderMatchQueryFlexible(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey)
      .populate("customer", "name email phone")
      .populate("items.product", ORDER_ITEM_PRODUCT_POPULATE)
      .populate("deliveryBoy", "name phone")
      .populate("returnDeliveryBoy", "name phone")
      .populate("seller", "shopName name address phone location")
      .lean();

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    // BUGFIX: Defensive check for customer reference integrity
    // If customer field is null or undefined, log error and attempt recovery
    if (!order.customer) {
      console.error(`[ORDER_BUG] Order ${orderId} has null/undefined customer field`, {
        orderId: order.orderId,
        _id: order._id,
        workflowStatus: order.workflowStatus,
        timestamp: new Date().toISOString(),
      });
      
      // Attempt to fetch order without populate to check raw customer field
      const rawOrder = await Order.findOne(orderKey).lean();
      if (rawOrder && rawOrder.customer) {
        // Customer reference exists but failed to populate
        console.error(`[ORDER_BUG] Customer reference exists but failed to populate`, {
          orderId: order.orderId,
          customerRef: rawOrder.customer,
        });
        // Use the raw customer reference for authorization
        order.customer = rawOrder.customer;
      } else {
        // Customer field is truly null/undefined in database
        console.error(`[ORDER_BUG] Customer field is null in database`, {
          orderId: order.orderId,
        });
        return handleResponse(
          res,
          500,
          "Order data integrity error: customer reference is missing",
        );
      }
    }

    if (!order.workflowStatus) {
      order.workflowStatus = resolveWorkflowStatus(order);
    }

    // --- Data Isolation Check ---
    const roleNorm = String(role || "").toLowerCase();
    const sellerIdStr =
      typeof order.seller === "object" && order.seller?._id
        ? order.seller._id.toString()
        : order.seller?.toString();
    
    // BUGFIX: Normalize customer reference to handle both populated and unpopulated cases
    const customerIdStr = refToIdString(order.customer);
    
    const isOwnerCustomer =
      (roleNorm === "customer" || roleNorm === "user") &&
      order.customer &&
      customerIdStr === uid;
    const isOwnerSeller = role === "seller" && sellerIdStr === uid;
    const primaryRiderId = refToIdString(order.deliveryBoy);
    const returnRiderId = refToIdString(order.returnDeliveryBoy);
    const isAssignedDeliveryBoy =
      role === "delivery" &&
      (primaryRiderId === uid || returnRiderId === uid);
    const isAdmin = role === "admin";

    if (
      !isOwnerCustomer &&
      !isOwnerSeller &&
      !isAssignedDeliveryBoy &&
      !isAdmin
    ) {
      // BUGFIX: Improved error message to distinguish authorization failure from missing order
      console.warn(`[ORDER_ACCESS] Authorization denied for order ${orderId}`, {
        orderId: order.orderId,
        requestedBy: uid,
        role: roleNorm,
        customerIdStr,
        hasCustomer: !!order.customer,
      });
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to view this order.",
      );
    }
    // -----------------------------
    
    // Inject Hub Location for Delivery Navigation if Hub Flow is enabled
    if (order.hubFlowEnabled) {
      const settings = await Setting.findOne().lean();
      if (settings && settings.hubLocation) {
        order.hubLocation = settings.hubLocation;
        order.hubAddress = settings.address;
      }
    }

    return handleResponse(res, 200, "Order details fetched", enrichOrderDoc(order));
  } catch (error) {
    console.error(`[ORDER_ERROR] Error fetching order details:`, error);
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   CANCEL ORDER
================================ */
export const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;
    const customerId = req.user.id;

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne({ ...orderKey, customer: customerId });

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    if (order.workflowVersion >= 2) {
      try {
        const updated = await customerCancelV2(
          customerId,
          order.orderId,
          reason,
        );
        if (isCodMethod(order.payment?.method)) {
          await applyCodCancellationStrike(customerId);
        }
        return handleResponse(res, 200, "Order cancelled successfully", updated);
      } catch (e) {
        return handleResponse(res, e.statusCode || 500, e.message);
      }
    }

    if (order.status !== "pending") {
      return handleResponse(
        res,
        400,
        "Order cannot be cancelled after confirmation",
      );
    }

    order.status = "cancelled";
    order.cancelledBy = "customer";
    order.cancelReason = reason || "Cancelled by user";
    await order.save();
    if (isCodMethod(order.payment?.method)) {
      await applyCodCancellationStrike(customerId);
    }

    return handleResponse(res, 200, "Order cancelled successfully", order);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   REQUEST RETURN (Customer)
================================ */
export const requestReturn = async (req, res) => {
  try {
    const { orderId } = req.params;
    const customerId = req.user.id;
    const { items, reason, images } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return handleResponse(
        res,
        400,
        "Please select at least one item to return.",
      );
    }
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return handleResponse(res, 400, "Return reason is required.");
    }

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne({ ...orderKey, customer: customerId });

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    if (order.status !== "delivered") {
      return handleResponse(
        res,
        400,
        "Return can only be requested for delivered orders.",
      );
    }

    if (order.returnStatus && order.returnStatus !== "none") {
      return handleResponse(
        res,
        400,
        "Return request already exists for this order.",
      );
    }

    const now = new Date();
    const deliveredAt = order.deliveredAt || order.updatedAt || order.createdAt;
    const deadline =
      order.returnDeadline ||
      new Date(deliveredAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    if (now > deadline) {
      return handleResponse(
        res,
        400,
        "Return window has expired for this order.",
      );
    }

    const selectedItems = [];
    for (const entry of items) {
      const { itemIndex, quantity } = entry || {};
      if (
        typeof itemIndex !== "number" ||
        itemIndex < 0 ||
        itemIndex >= order.items.length
      ) {
        return handleResponse(res, 400, "Invalid item selection for return.");
      }
      const original = order.items[itemIndex];
      const qty = Number(quantity) || original.quantity;
      if (qty <= 0 || qty > original.quantity) {
        return handleResponse(
          res,
          400,
          "Invalid quantity for one of the return items.",
        );
      }

      selectedItems.push({
        product: original.product,
        name: original.name,
        quantity: qty,
        price: original.price,
        variantSlot: original.variantSlot,
        variantId: original.variantId || undefined,
        itemIndex,
        status: "requested",
      });
    }

    order.returnStatus = "return_requested";
    order.returnReason = reason.trim();
    order.returnImages = Array.isArray(images) ? images.slice(0, 5) : [];
    order.returnItems = selectedItems;
    order.returnRequestedAt = now;
    order.returnDeadline = deadline;

    await order.save();

    // Basic notification for seller about new return request
    if (order.seller) {
      await createNotification({
        recipient: order.seller,
        recipientModel: "Seller",
        title: "New Return Request",
        message: `Customer requested a return for order #${order.orderId}.`,
        type: "order",
        data: { orderId: order.orderId, mongoOrderId: order._id },
      });
    }

    return handleResponse(
      res,
      200,
      "Return request submitted successfully",
      order,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET RETURN DETAILS (Order-scoped)
================================ */
export const getReturnDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { id: userId, role } = req.user;

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey)
      .populate("customer", "name phone")
      .populate("seller", "shopName name")
      .populate("returnDeliveryBoy", "name phone");

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    const isOwnerCustomer =
      (role === "customer" || role === "user") &&
      order.customer?._id?.toString() === userId;
    const isOwnerSeller =
      role === "seller" && order.seller?._id?.toString() === userId;
    const isAssignedReturnDelivery =
      role === "delivery" &&
      order.returnDeliveryBoy?._id?.toString() === userId;
    const isAdmin = role === "admin";

    if (
      !isOwnerCustomer &&
      !isOwnerSeller &&
      !isAssignedReturnDelivery &&
      !isAdmin
    ) {
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to view this return.",
      );
    }

    let returnDeliveryCommission = order.returnDeliveryCommission;
    if (
      returnDeliveryCommission === undefined ||
      returnDeliveryCommission === null
    ) {
      try {
        const settings = await Setting.findOne({});
        returnDeliveryCommission = settings?.returnDeliveryCommission ?? 0;
      } catch {
        returnDeliveryCommission = 0;
      }
    }

    const payload = {
      orderId: order.orderId,
      status: order.status,
      returnStatus: order.returnStatus,
      returnReason: order.returnReason,
      returnRejectedReason: order.returnRejectedReason,
      returnRequestedAt: order.returnRequestedAt,
      returnDeadline: order.returnDeadline,
      returnImages: order.returnImages || [],
      returnItems: order.returnItems || [],
      returnRefundAmount: order.returnRefundAmount,
      returnDeliveryCommission,
      returnDeliveryBoy: order.returnDeliveryBoy || null,
    };

    return handleResponse(res, 200, "Return details fetched", payload);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE ORDER STATUS (Admin/Seller/Delivery)
================================ */
export const updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, deliveryBoyId } = req.body;
    const { id: userId, role } = req.user;

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    const canonicalOrderId = order.orderId;

    if (
      order.workflowVersion >= 2 &&
      role === "admin" &&
      status === "confirmed" &&
      order.hubFlowEnabled
    ) {
      try {
        const updated = await startHubDeliverySearchAtomic(canonicalOrderId);
        return handleResponse(
          res,
          200,
          "Hub order dispatched to delivery search",
          updated,
        );
      } catch (e) {
        return handleResponse(res, e.statusCode || 500, e.message);
      }
    }

    if (order.workflowVersion >= 2 && role === "seller") {
      if (status === "confirmed") {
        try {
          // SOP Step 9: Vendor receives purchase request through their seller application.
          // Sellers (Vendors) do NOT fulfill customer orders directly. They only fulfill Purchase Requests to the Hub.
          if (order.hubFlowEnabled) {
            console.log(`[updateOrderStatus] Hub-flow order detected: ${order.orderId}. Checking PR for vendor: ${userId}`);
            const PurchaseRequest = mongoose.model("PurchaseRequest");
            
            const vendorObjectId = new mongoose.Types.ObjectId(userId);
            
            const pr = await PurchaseRequest.findOne({
              orderId: order._id,
              vendorId: vendorObjectId,
              status: "created",
            });
            
            if (pr) {
              console.log(`[updateOrderStatus] Found pending PR ${pr.requestId}. Accepting...`);
              pr.vendorResponse = {
                status: "accepted",
                respondedAt: new Date(),
                notes: "Accepted via vendor dashboard",
              };
              pr.status = "vendor_confirmed";
              await pr.save();
              
              // Notify admin via socket that a vendor has accepted
              emitToAdminOrdersRoom({
                event: "purchase_request:accepted",
                payload: {
                  orderId: order.orderId,
                  vendorId: userId,
                  purchaseRequestId: pr._id,
                },
               });

              return handleResponse(res, 200, "Purchase request confirmed. Preparing for pickup.", order);
            } else {
              return handleResponse(res, 400, "No pending purchase request found for this order.");
            }
          } else {
            return handleResponse(res, 400, "Direct fulfillment is disabled. Orders must go through the Hub.");
          }
        } catch (e) {
          return handleResponse(res, e.statusCode || 500, e.message);
        }
      }
      if (status === "cancelled") {
        try {
          // If this is a hub order, we might need to reject a purchase request instead
          if (order.hubFlowEnabled) {
            const PurchaseRequest = mongoose.model("PurchaseRequest");
            const vendorObjectId = new mongoose.Types.ObjectId(userId);
            const pr = await PurchaseRequest.findOne({
              orderId: order._id,
              vendorId: vendorObjectId,
              status: "created",
            });
            if (pr) {
              pr.vendorResponse = {
                status: "rejected",
                respondedAt: new Date(),
                rejectionReason: "Declined via seller dashboard",
                notes: "Rejected via order dashboard modal",
              };
              pr.status = "exception";
              pr.exceptionReason = "Declined by vendor";
              await pr.save();
              return handleResponse(res, 200, "Purchase request declined", order);
            }
          }

          const updated = await sellerRejectAtomic(userId, canonicalOrderId);
          return handleResponse(res, 200, "Order rejected", updated);
        } catch (e) {
          return handleResponse(res, e.statusCode || 500, e.message);
        }
      }
    }

    // --- Data Isolation Check ---
    const isOwnerSeller =
      role === "seller" && order.seller?.toString() === userId;
    const isAssignedDeliveryBoy =
      role === "delivery" && order.deliveryBoy?.toString() === userId;
    const isAdmin = role === "admin";

    if (!isOwnerSeller && !isAssignedDeliveryBoy && !isAdmin) {
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to update this order.",
      );
    }
    // -----------------------------

    const oldStatus = order.status;

    // Manual rider assignment (Admin fallback when auto-assign fails)
    if (deliveryBoyId && role === "admin" && order.workflowVersion >= 2) {
      if (String(order.status || "").toLowerCase() === "cancelled") {
        return handleResponse(res, 400, "Cannot assign rider to a cancelled order.");
      }
      if (String(order.status || "").toLowerCase() === "delivered") {
        return handleResponse(res, 400, "Cannot assign rider to a delivered order.");
      }
      if (order.deliveryBoy) {
        return handleResponse(res, 400, "Order already assigned to a delivery partner.");
      }
      order.deliveryBoy = deliveryBoyId;
      order.workflowStatus = WORKFLOW_STATUS.DELIVERY_ASSIGNED;
      order.assignedAt = new Date();

      // Keep legacy status flow consistent if order is still pending.
      if (String(order.status || "").toLowerCase() === "pending") {
        order.status = "confirmed";
      }
    }

    if (status) order.status = status;

    // Legacy orders: keep rider UI step in sync with status (delivery app refresh-safe)
    if (
      isAssignedDeliveryBoy &&
      role === "delivery" &&
      order.workflowVersion < 2 &&
      status
    ) {
      if (status === "packed") order.deliveryRiderStep = 2;
      else if (status === "out_for_delivery") order.deliveryRiderStep = 3;
    }

    // Handle Cancellation (Stock Reversal & Transaction Update)
    if (status === "cancelled" && oldStatus !== "cancelled") {
      for (const item of order.items) {
        await reverseOrderItemStock(item, order);
      }

      // 2. Update Transaction
      await Transaction.findOneAndUpdate(
        { reference: canonicalOrderId },
        { status: "Failed" },
      );
    }

    // Handle Confirmation/Delivery (Settle Transaction for Demo)
    if (status === "delivered" && oldStatus !== "delivered") {
      order.deliveredAt = new Date();
      await Transaction.findOneAndUpdate(
        { reference: canonicalOrderId, userModel: "Seller" },
        { status: "Settled" },
      );

      // Create Delivery Earning Transaction
      if (order.deliveryBoy) {
        const deliveryEarning = order.pricing?.deliveryFee || 0;
        await Transaction.create({
          user: order.deliveryBoy,
          userModel: "Delivery",
          order: order._id,
          type: "Delivery Earning",
          amount: deliveryEarning,
          status: "Settled",
          reference: `DEL-ERN-${canonicalOrderId}`,
        });

        // --- NEW: Cash Collection Logic for COD ---
        if (
          order.payment?.method?.toLowerCase() === "cash" ||
          order.payment?.method?.toLowerCase() === "cod"
        ) {
          console.log(
            "Creating Cash Collection Transaction for order:",
            canonicalOrderId,
          );
          await Transaction.create({
            user: order.deliveryBoy,
            userModel: "Delivery",
            order: order._id,
            type: "Cash Collection",
            amount: order.pricing.total,
            status: "Settled", // Settled means rider has the cash
            reference: `CASH-COL-${canonicalOrderId}`,
          });
        }
      }
    }

    console.log("Saving order with new status:", status);
    await order.save();

    if (status === "confirmed" && role === "seller") {
      // This order is now 'Automatic' for delivery partners
      console.log("Order confirmed, available for delivery.");
    }

    return handleResponse(res, 200, "Order status updated", order);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   APPROVE RETURN (Seller/Admin)
================================ */
export const approveReturnRequest = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { id: userId, role } = req.user;

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    const isOwnerSeller =
      role === "seller" && order.seller?.toString() === userId;
    const isAdmin = role === "admin";

    if (!isOwnerSeller && !isAdmin) {
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to approve this return.",
      );
    }

    if (order.returnStatus !== "return_requested") {
      return handleResponse(
        res,
        400,
        "Only pending return requests can be approved.",
      );
    }

    if (!Array.isArray(order.returnItems) || order.returnItems.length === 0) {
      return handleResponse(res, 400, "No return items found for this order.");
    }

    const refundAmount = order.returnItems.reduce(
      (sum, item) => sum + (item.price || 0) * (item.quantity || 0),
      0,
    );

    const settings = await Setting.findOne({});
    const returnCommission = settings?.returnDeliveryCommission ?? 0;

    order.returnItems = order.returnItems.map((item) => ({
      ...(item.toObject?.() ?? item),
      status: "approved",
    }));
    order.returnStatus = "return_approved";
    order.returnRefundAmount = refundAmount;
    order.returnDeliveryCommission = returnCommission;

    await order.save();

    return handleResponse(res, 200, "Return request approved", order);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   REJECT RETURN (Seller/Admin)
================================ */
export const rejectReturnRequest = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { id: userId, role } = req.user;
    const { reason } = req.body || {};

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return handleResponse(res, 400, "Rejection reason is required.");
    }

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    const isOwnerSeller =
      role === "seller" && order.seller?.toString() === userId;
    const isAdmin = role === "admin";

    if (!isOwnerSeller && !isAdmin) {
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to reject this return.",
      );
    }

    if (order.returnStatus !== "return_requested") {
      return handleResponse(
        res,
        400,
        "Only pending return requests can be rejected.",
      );
    }

    order.returnStatus = "return_rejected";
    order.returnRejectedReason = reason.trim();

    await order.save();

    return handleResponse(res, 200, "Return request rejected", order);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   ASSIGN RETURN DELIVERY (Seller/Admin)
================================ */
export const assignReturnDelivery = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { id: userId, role } = req.user;
    const { deliveryBoyId } = req.body || {};

    if (!deliveryBoyId) {
      return handleResponse(res, 400, "deliveryBoyId is required.");
    }

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    const isOwnerSeller =
      role === "seller" && order.seller?.toString() === userId;
    const isAdmin = role === "admin";

    if (!isOwnerSeller && !isAdmin) {
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to assign return pickup.",
      );
    }

    if (order.returnStatus !== "return_approved") {
      return handleResponse(
        res,
        400,
        "Return pickup can only be assigned after approval.",
      );
    }

    const partner = await Delivery.findById(deliveryBoyId);
    if (!partner) {
      return handleResponse(res, 404, "Delivery partner not found.");
    }

    order.returnDeliveryBoy = deliveryBoyId;
    order.returnStatus = "return_pickup_assigned";

    await order.save();

    await createNotification({
      recipient: deliveryBoyId,
      recipientModel: "Delivery",
      title: "Return Pickup Assigned",
      message: `A return pickup has been assigned for order #${order.orderId}.`,
      type: "order",
      data: { orderId: order.orderId, mongoOrderId: order._id },
    });

    return handleResponse(
      res,
      200,
      "Return pickup assigned successfully",
      order,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

const completeReturnAndRefund = async (order) => {
  if (!order) return null;
  if (order.returnStatus === "refund_completed") {
    return order;
  }

  const refundAmount =
    order.returnRefundAmount ||
    (Array.isArray(order.returnItems)
      ? order.returnItems.reduce(
          (sum, item) => sum + (item.price || 0) * (item.quantity || 0),
          0,
        )
      : 0);

  const commission = order.returnDeliveryCommission || 0;

  // 1. Credit customer wallet
  if (order.customer && refundAmount > 0) {
    const customer = await User.findById(order.customer);
    if (customer) {
      customer.walletBalance = (customer.walletBalance || 0) + refundAmount;
      await customer.save();

      await Transaction.create({
        user: customer._id,
        userModel: "User",
        order: order._id,
        type: "Refund",
        amount: refundAmount,
        status: "Settled",
        reference: `REF-CUST-${order.orderId}`,
      });
    }
  }

  // 2. Seller adjustment (refund + return commission)
  if (order.seller && (refundAmount > 0 || commission > 0)) {
    const adjustment = -Math.abs(refundAmount + commission);
    await Transaction.create({
      user: order.seller,
      userModel: "Seller",
      order: order._id,
      type: "Refund",
      amount: adjustment,
      status: "Settled",
      reference: `REF-SELL-${order.orderId}`,
    });
  }

  // 3. Delivery partner earning for return pickup
  if (order.returnDeliveryBoy && commission > 0) {
    await Transaction.create({
      user: order.returnDeliveryBoy,
      userModel: "Delivery",
      order: order._id,
      type: "Delivery Earning",
      amount: commission,
      status: "Settled",
      reference: `RET-DEL-${order.orderId}`,
    });
  }

  order.returnStatus = "refund_completed";
  if (order.payment) {
    order.payment.status = "refunded";
  }

  await order.save();
  return order;
};

/* ===============================
   UPDATE RETURN STATUS (Delivery/Admin)
================================ */
export const updateReturnStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { returnStatus } = req.body || {};
    const { id: userId, role } = req.user;

    if (!returnStatus) {
      return handleResponse(res, 400, "returnStatus is required.");
    }

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    const isAssignedReturnDelivery =
      role === "delivery" && order.returnDeliveryBoy?.toString() === userId;
    const isAdmin = role === "admin";

    if (!isAssignedReturnDelivery && !isAdmin) {
      return handleResponse(
        res,
        403,
        "Access denied. You are not authorized to update this return.",
      );
    }

    const oldStatus = order.returnStatus;
    const allowedStatuses = [
      "return_pickup_assigned",
      "return_in_transit",
      "returned",
    ];

    if (!allowedStatuses.includes(returnStatus)) {
      return handleResponse(res, 400, "Invalid returnStatus value.");
    }

    // Only allow forward transitions
    const orderOf = (s) =>
      s === "return_pickup_assigned"
        ? 1
        : s === "return_in_transit"
          ? 2
          : s === "returned"
            ? 3
            : 0;

    if (orderOf(returnStatus) < orderOf(oldStatus)) {
      return handleResponse(res, 400, "Return status cannot move backwards.");
    }

    const now = new Date();

    if (returnStatus === "return_in_transit") {
      order.returnStatus = "return_in_transit";
      if (!order.returnPickedAt) {
        order.returnPickedAt = now;
      }
      await order.save();
      return handleResponse(res, 200, "Return status updated", order);
    }

    if (returnStatus === "returned") {
      order.returnStatus = "returned";
      if (!order.returnDeliveredBackAt) {
        order.returnDeliveredBackAt = now;
      }
      await order.save();

      const updated = await completeReturnAndRefund(order);
      return handleResponse(
        res,
        200,
        "Return received and refund processed",
        updated,
      );
    }

    order.returnStatus = returnStatus;
    await order.save();

    return handleResponse(res, 200, "Return status updated", order);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET SELLER ORDERS
================================ */
export const getSellerOrders = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { startDate, endDate, status: statusParam } = req.query;

    // If admin, fetch all orders.
    // If seller, fetch:
    // 1) legacy/direct seller orders (order.seller === userId)
    // 2) hub-flow orders where this seller has linked purchase requests.
    let query = {};
    if (role === "admin") {
      query = {};
    } else {
      const linkedOrderIds = await PurchaseRequest.distinct("orderId", {
        vendorId: userId,
      });
      query = {
        $or: [
          { seller: userId },
          { _id: { $in: linkedOrderIds } },
        ],
      };
    }

    /**
     * Admin sidebar uses URL segments (e.g. processed, out-for-delivery) that
     * do not match DB enum values (confirmed/packed, out_for_delivery).
     */
    if (statusParam && statusParam !== "all") {
      if (statusParam === "pending") {
        query.$or = [
          { status: "pending" },
          { workflowStatus: "DELIVERY_SEARCH" },
          { workflowStatus: "CREATED" },
          { workflowStatus: "SELLER_PENDING" }
        ];
      } else if (statusParam === "processed") {
        query.status = { $in: ["confirmed", "packed"] };
      } else if (statusParam === "out-for-delivery") {
        query.status = "out_for_delivery";
      } else if (statusParam === "delivered") {
        query.status = "delivered";
      } else if (statusParam === "cancelled") {
        query.status = "cancelled";
      } else if (statusParam === "returned") {
        query.returnStatus = { $ne: "none" };
      }
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // include entire end date day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    console.log("Fetching Orders - User role:", role, "User ID:", userId);

    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 100,
    });

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("customer", "name phone")
      .populate("items.product", ORDER_ITEM_PRODUCT_POPULATE)
      .populate("deliveryBoy", "name phone")
      .populate("seller", "shopName name")
      .lean();

    const total = await Order.countDocuments(query);

    // Enrich orders with action required info for sellers to guide the frontend modal/alerts
    const enrichedItems = await Promise.all(orders.map(async (o) => {
      const item = enrichOrderDoc(o);
      if (role !== "seller") return item;

      if (o.hubFlowEnabled) {
          // Check if there's a pending purchase request for this seller
          const PurchaseRequest = mongoose.model("PurchaseRequest");
          const vendorObjectId = new mongoose.Types.ObjectId(userId);
          const pr = await PurchaseRequest.findOne({ 
              orderId: o._id, 
              vendorId: vendorObjectId, 
              status: "created" 
          }).lean();
          
          if (pr) {
             console.log(`[getSellerOrders] Order ${o.orderId} requires action from vendor ${userId} (PR: ${pr.requestId})`);
          }
          item.requiresAction = !!pr;
      } else {
          // Standard direct order
          item.requiresAction = o.workflowStatus === WORKFLOW_STATUS.SELLER_PENDING;
      }
      return item;
    }));

    console.log("Fetched Orders Page:", page, "Count:", orders.length);

    return handleResponse(
      res,
      200,
      role === "admin" ? "All orders fetched" : "Seller orders fetched",
      {
        items: enrichedItems,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET AVAILABLE ORDERS (Delivery Boy)
================================ */
export const getAvailableOrders = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    if (role !== "delivery" && role !== "admin") {
      return handleResponse(
        res,
        403,
        "Access denied. Only delivery partners can view available orders.",
      );
    }

    const settings = await Setting.findOne().lean();
    const hubAddress = settings?.address || "Main Logistics Hub";

    // 1. Get delivery boy's location
    const deliveryPartner = await Delivery.findById(userId);
    if (
      !deliveryPartner ||
      !deliveryPartner.location ||
      !deliveryPartner.location.coordinates
    ) {
      return handleResponse(
        res,
        200,
        "Update your location to see nearby orders",
        [],
      );
    }

    // 2. Find nearby sellers (within 5km)
    let nearbySellers = await Seller.find({
      location: {
        $near: {
          $geometry: deliveryPartner.location,
          $maxDistance: 5000, // 5km
        },
      },
    }).select("_id");

    let sellerIds = nearbySellers.map((s) => s._id);

    // FALLBACK: If in development/testing and no nearby sellers found, show all available orders
    if (sellerIds.length === 0 && process.env.NODE_ENV !== "production") {
      console.log(
        `DEV LOG - Radius search found 0 sellers. Bypassing radius check for Delivery Partner: ${userId}`,
      );
      const allSellers = await Seller.find({}).select("_id");
      sellerIds = allSellers.map((s) => s._id);
    }

    const maxLimit = 50;
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, maxLimit)
        : 20;

    const [dlng, dlat] = deliveryPartner.location.coordinates;

    const v2Orders = await Order.find({
      workflowVersion: { $gte: 2 },
      workflowStatus: WORKFLOW_STATUS.DELIVERY_SEARCH,
      deliveryBoy: null,
      skippedBy: { $nin: [userId] },
      $or: [
        { seller: { $in: sellerIds } },
        { hubFlowEnabled: true },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("customer", "name phone")
      .populate("seller", "shopName address name location serviceRadius")
      .lean();

    const v2Filtered = v2Orders.filter((o) => {
      const coords = o.seller?.location?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return true;
      const [slng, slat] = coords;
      const searchR = o.deliverySearchMeta?.radiusMeters || 5000;
      const serviceKm = Number(o.seller?.serviceRadius ?? 5);
      const serviceM = Math.max(serviceKm, 0) * 1000;
      const maxR = Math.min(searchR, serviceM);
      return distanceMeters(dlat, dlng, slat, slng) <= maxR;
    });

    const legacyOrders = await Order.find({
      $or: [
        { workflowVersion: { $exists: false } },
        { workflowVersion: { $lt: 2 } },
      ],
      status: { $in: ["confirmed", "packed"] },
      deliveryBoy: null,
      seller: { $in: sellerIds },
      skippedBy: { $nin: [userId] },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("customer", "name phone")
      .populate("seller", "shopName address name location")
      .lean();

    const seen = new Set();
    const merged = [];
    for (const o of [...v2Filtered, ...legacyOrders]) {
      if (seen.has(o.orderId)) continue;
      seen.add(o.orderId);
      
      // Inject Hub Address for UI if hub flow
      if (o.hubFlowEnabled) {
        o.pickupAddress = hubAddress;
      }
      
      merged.push(o);
      if (merged.length >= limit) break;
    }

    console.log(
      `Delivery Partner (${userId}) - Available orders found: ${merged.length}`,
    );

    return handleResponse(
      res,
      200,
      merged.length > 0 ? "Available orders fetched" : "No orders found",
      merged,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   ACCEPT ORDER (Delivery Boy)
================================ */
export const acceptOrder = async (req, res) => {
  try {
    const orderId = decodeURIComponent(String(req.params.orderId || "")).trim();
    const userId = req.user?.id ?? req.user?._id;
    const { role } = req.user;

    if (!userId) {
      return handleResponse(res, 401, "Invalid or incomplete token");
    }

    if (role !== "delivery" && role !== "admin") {
      return handleResponse(res, 403, "Access denied.");
    }

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    if (order.workflowVersion >= 2) {
      try {
        const idem = req.headers["idempotency-key"];
        const { order: updated, duplicate } = await deliveryAcceptAtomic(
          userId,
          order.orderId,
          idem,
        );
        return handleResponse(
          res,
          200,
          duplicate ? "Already accepted" : "Order accepted successfully",
          updated,
        );
      } catch (e) {
        return handleResponse(res, e.statusCode || 500, e.message);
      }
    }

    if (order.deliveryBoy) {
      return handleResponse(
        res,
        400,
        "Order already assigned to another delivery partner",
      );
    }

    order.deliveryBoy = userId;
    if (order.status === "pending") {
      order.status = "confirmed";
    }

    await order.save();

    await createNotification({
      recipient: order.seller,
      recipientModel: "Seller",
      title: "Delivery Partner Assigned",
      message: `Delivery partner has been assigned to your order #${order.orderId}.`,
      type: "order",
      data: { orderId: order.orderId, mongoOrderId: order._id },
    });

    return handleResponse(res, 200, "Order accepted successfully", order);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   SKIP ORDER (Delivery Boy)
================================ */
export const skipOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { id: userId, role } = req.user;

    if (role !== "delivery" && role !== "admin") {
      return handleResponse(res, 403, "Access denied.");
    }

    const orderKey = orderMatchQueryFromRouteParam(orderId);
    if (!orderKey) {
      return handleResponse(res, 404, "Order not found");
    }

    const order = await Order.findOne(orderKey);

    if (!order) {
      return handleResponse(res, 404, "Order not found");
    }

    // Add user to skippedBy array if not already there
    if (order.workflowVersion >= 2) {
      if (order.workflowStatus !== WORKFLOW_STATUS.DELIVERY_SEARCH) {
        return handleResponse(
          res,
          400,
          "Order cannot be skipped in current state",
        );
      }
    }

    if (!order.skippedBy.includes(userId)) {
      order.skippedBy.push(userId);
      await order.save();
    }

    return handleResponse(res, 200, "Order skipped successfully");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

