import mongoose from "mongoose";
import crypto from "crypto";
import PurchaseRequest from "../models/purchaseRequest.js";
import HubInward from "../models/hubInward.js";
import HubInventory from "../models/hubInventory.js";
import Product from "../models/product.js";
import Order from "../models/order.js";
import Seller from "../models/seller.js";
import PickupPartner from "../models/pickupPartner.js";
import { WORKFLOW_STATUS } from "../constants/orderWorkflow.js";
import { startHubDeliverySearchAtomic } from "../services/orderWorkflowService.js";
import Transaction from "../models/transaction.js";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";

const DEFAULT_HUB_ID = process.env.DEFAULT_HUB_ID || "MAIN_HUB";

const PR_DONE_STATUSES = new Set(["verified", "closed", "cancelled"]);

const PR_IN_DELIVERY_STATUSES = new Set([
  "pickup_assigned",
  "picked",
  "hub_delivered",
]);

const PR_AWAITING_VENDOR_STATUSES = new Set(["created", "vendor_confirmed"]);

const prStatusLabel = (status) => {
  const map = {
    created: "Pending vendor",
    vendor_confirmed: "Vendor confirmed",
    pickup_assigned: "Pickup assigned",
    picked: "In transit to hub",
    hub_delivered: "At hub gate",
    received_at_hub: "Received at hub",
    verified: "Verified & stocked",
    closed: "Closed",
    cancelled: "Cancelled",
    exception: "Exception",
  };
  return map[String(status || "")] || String(status || "—");
};

const PICKUP_OTP_EXPIRY_MINUTES = Math.max(
  1,
  Number(process.env.PICKUP_OTP_EXPIRY_MINUTES || 30),
);
const PICKUP_OTP_MOCK_MODE =
  String(process.env.PICKUP_OTP_MOCK_MODE || "").toLowerCase() === "true";
const PICKUP_OTP_MOCK_VALUE = String(process.env.PICKUP_OTP_MOCK_VALUE || "1234");
const DEFAULT_MARGIN_TYPE = String(
  process.env.DEFAULT_PROCUREMENT_MARGIN_TYPE || "percent",
).toLowerCase() === "flat"
  ? "flat"
  : "percent";
const DEFAULT_MARGIN_VALUE = Math.max(
  0,
  Number(process.env.DEFAULT_PROCUREMENT_MARGIN_VALUE || 15),
);
const toMoney = (value) => Math.max(0, Number(Number(value || 0).toFixed(2)));
const resolveMarginType = (value) =>
  String(value || "").toLowerCase() === "flat" ? "flat" : "percent";
const resolveMarginValue = (value) => Math.max(0, Number(value || 0));
const computeSellPrice = (cost, marginType, marginValue) => {
  const base = Math.max(0, Number(cost || 0));
  if (resolveMarginType(marginType) === "flat") {
    return toMoney(base + resolveMarginValue(marginValue));
  }
  return toMoney(base + (base * resolveMarginValue(marginValue)) / 100);
};

const hashPickupOtp = (otp) =>
  crypto.createHash("sha256").update(String(otp)).digest("hex");

const generatePickupOtp = () => {
  if (PICKUP_OTP_MOCK_MODE) return PICKUP_OTP_MOCK_VALUE;
  return String(Math.floor(1000 + Math.random() * 9000));
};

const generateRequestId = () =>
  `PR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

const pickBestPickupPartner = async (hubId = DEFAULT_HUB_ID) => {
  const candidates = await PickupPartner.find({
    hubId: String(hubId || DEFAULT_HUB_ID),
    isActive: true,
    isVerified: true,
    status: { $in: ["available", "active"] },
  })
    .select("_id name status")
    .lean();

  if (!candidates.length) return null;

  const ids = candidates.map((c) => c._id);
  const activeCounts = await PurchaseRequest.aggregate([
    {
      $match: {
        pickupPartnerId: { $in: ids },
        status: { $in: ["pickup_assigned", "picked"] },
      },
    },
    {
      $group: {
        _id: "$pickupPartnerId",
        count: { $sum: 1 },
      },
    },
  ]);
  const countMap = new Map(
    activeCounts.map((r) => [String(r._id), Number(r.count || 0)]),
  );

  const sorted = [...candidates].sort((a, b) => {
    const ac = countMap.get(String(a._id)) || 0;
    const bc = countMap.get(String(b._id)) || 0;
    if (ac !== bc) return ac - bc;
    if (a.status === "available" && b.status !== "available") return -1;
    if (b.status === "available" && a.status !== "available") return 1;
    return 0;
  });

  return sorted[0] || null;
};

const assignPickupToRequest = async (doc, partner) => {
  doc.pickupPartnerId = partner._id;
  doc.pickupPartnerName = String(partner.name || "").trim();
  const otp = generatePickupOtp();
  doc.pickupOtpCode = otp;
  doc.pickupOtpHash = hashPickupOtp(otp);
  doc.pickupOtpExpiresAt = new Date(
    Date.now() + PICKUP_OTP_EXPIRY_MINUTES * 60 * 1000,
  );
  doc.pickupOtpVerifiedAt = undefined;
  doc.pickupProof = undefined;
  doc.hubDropProof = undefined;
  doc.exceptionReason = "";
  doc.status = "pickup_assigned";
  await doc.save();
  await PickupPartner.findByIdAndUpdate(partner._id, {
    $set: { status: "active", isActive: true },
  });

  // Notify pickup partner about new assignment
  try {
    const { createNotification } = await import("../services/notificationService.js");
    
    // Construct a more descriptive message
    const firstItem = doc.items?.[0];
    const productName = firstItem?.productId?.name || "Products";
    const qty = firstItem?.shortageQty || firstItem?.requiredQty || 0;
    const moreCount = (doc.items?.length || 0) - 1;
    const itemSummary = `${productName} x ${qty}${moreCount > 0 ? ` (+${moreCount} more)` : ""}`;
    
    await createNotification({
      recipient: partner._id,
      recipientModel: "PickupPartner",
      title: "New Pickup Task",
      message: `Pickup ${itemSummary} from ${doc.vendorName || "a vendor"}. Request ID: ${doc.requestId}`,
      type: "order",
      data: { 
        requestId: doc.requestId, 
        purchaseRequestId: doc._id.toString(),
        orderId: doc.orderId?.toString(),
        productSummary: itemSummary
      },
    });
  } catch (error) {
    console.warn("[assignPickupToRequest] Notification failed:", error.message);
  }

  return otp;
};

const mapPrPhase = (status) => {
  if (PR_IN_DELIVERY_STATUSES.has(status)) return "in_delivery";
  if (PR_AWAITING_VENDOR_STATUSES.has(status)) return "awaiting_vendor";
  if (status === "received_at_hub") return "at_hub";
  if (status === "exception") return "exception";
  if (PR_DONE_STATUSES.has(status)) return "completed";
  return "other";
};

const mapRow = (reqDoc) => {
  const items = Array.isArray(reqDoc.items) ? reqDoc.items : [];
  const item = items[0] || null;
  const quantity = Number(item?.shortageQty || item?.requiredQty || reqDoc.quantity || 0);
  const unitCost = Number(item?.vendorUnitCost || 0);
  const gstAmount = Number(item?.gstAmount || 0);
  const lineTotal = toMoney(unitCost * quantity + gstAmount);
  const status = String(reqDoc.status || "");

  return {
    _id: reqDoc._id,
    requestId: reqDoc.requestId,
    orderId: reqDoc.orderId,
    vendorId: reqDoc.vendorId?._id || reqDoc.vendorId || null,
    vendorName:
      reqDoc.vendorId?.shopName ||
      reqDoc.vendorId?.name ||
      reqDoc.vendorName ||
      "Unassigned Vendor",
    productId: item?.productId?._id || item?.productId || null,
    product:
      item?.productId?.name ||
      reqDoc.product ||
      (items.length > 1 ? `${items.length} items` : "Product"),
    quantity,
    unitCost,
    totalCost: lineTotal,
    gstRate: Number(item?.gstRate || 0),
    gstAmount,
    status,
    statusLabel: prStatusLabel(status),
    phase: mapPrPhase(status),
    isOpen: !PR_DONE_STATUSES.has(status),
    vendorResponse: reqDoc.vendorResponse?.status || "pending",
    pickupPartnerId: reqDoc.pickupPartnerId?._id || reqDoc.pickupPartnerId || null,
    pickupPartnerName:
      reqDoc.pickupPartnerId?.name || reqDoc.pickupPartnerName || "",
    pickupPartnerPhone: reqDoc.pickupPartnerId?.phone || "",
    notes: reqDoc.notes || "",
    exceptionReason: reqDoc.exceptionReason || "",
    eta: reqDoc.eta || null,
    createdAt: reqDoc.createdAt,
    updatedAt: reqDoc.updatedAt,
    items: items.map((row) => ({
      productId: row.productId?._id || row.productId || null,
      productName: row.productId?.name || "Product",
      quantity: Number(row.shortageQty || row.requiredQty || 0),
      unitCost: Number(row.vendorUnitCost || 0),
      totalCost: toMoney(
        Number(row.vendorUnitCost || 0) * Number(row.shortageQty || row.requiredQty || 0) +
          Number(row.gstAmount || 0),
      ),
    })),
  };
};

const mapSellerRow = (reqDoc) => ({
  _id: reqDoc._id,
  requestId: reqDoc.requestId,
  orderId: reqDoc.orderId?._id || reqDoc.orderId || null,
  orderCode: reqDoc.orderId?.orderId || "",
  hubId: reqDoc.hubId,
  status: reqDoc.status,
  vendorResponse: reqDoc.vendorResponse || { status: "pending" },
  vendorReadyAt: reqDoc.vendorReadyAt || null,
  vendorReadyNotes: reqDoc.vendorReadyNotes || "",
  pickupPartner: reqDoc.pickupPartnerId
    ? {
        id: reqDoc.pickupPartnerId?._id || reqDoc.pickupPartnerId,
        name:
          reqDoc.pickupPartnerId?.name ||
          reqDoc.pickupPartnerName ||
          "Pickup Partner",
        phone: reqDoc.pickupPartnerId?.phone || "",
      }
    : null,
  pickupAssigned: Boolean(reqDoc.pickupPartnerId),
  pickupOtp:
    String(reqDoc.status) === "pickup_assigned" &&
    (!reqDoc.pickupOtpExpiresAt || new Date(reqDoc.pickupOtpExpiresAt) > new Date())
      ? String(reqDoc.pickupOtpCode || "")
      : "",
  pickupOtpExpiresAt: reqDoc.pickupOtpExpiresAt || null,
  items: (reqDoc.items || []).map((item) => ({
    productId: item.productId?._id || item.productId || null,
    productName: item.productId?.name || "Product",
    mainImage: item.productId?.mainImage || null,
    unit: item.productId?.unit || "Unit",
    requiredQty: Number(item.requiredQty || 0),
    shortageQty: Number(item.shortageQty || 0),
    committedQty: Number(item.committedQty || 0),
    unitCost: Number(item.vendorUnitCost || 0),
    gstRate: Number(item.gstRate || 0),
    gstAmount: Number(item.gstAmount || 0),
  })),
  notes: reqDoc.notes || "",
  exceptionReason: reqDoc.exceptionReason || "",
  createdAt: reqDoc.createdAt,
  updatedAt: reqDoc.updatedAt,
});

export const getPurchaseRequestProductContext = async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return handleResponse(res, 400, "Valid productId is required");
    }

    const product = await Product.findById(productId)
      .populate("sellerId", "shopName name phone email isVerified status")
      .populate("categoryId", "name")
      .populate("subcategoryId", "name")
      .populate({
        path: "masterProductId",
        select: "name slug status price salePrice stock mainImage unit",
      })
      .lean();

    if (!product || product.ownerType !== "seller") {
      return handleResponse(res, 404, "Seller listing not found");
    }

    const vendorId = product.sellerId?._id || product.sellerId;
    if (!vendorId) {
      return handleResponse(res, 400, "This product has no linked vendor");
    }

    const sellerStock = (() => {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      if (variants.length) {
        return variants.reduce((sum, v) => sum + (Number(v?.stock) || 0), 0);
      }
      return Math.max(0, Number(product.stock) || 0);
    })();

    const isCatalogListing = Boolean(product.masterProductId);
    const listingType = isCatalogListing ? "catalog" : "seller_own";
    const supplyPrice = Number(
      product.purchasePrice ?? product.price ?? product.salePrice ?? 0,
    );

    const [openRequests, recentCompleted] = await Promise.all([
      PurchaseRequest.find({
        vendorId,
        status: { $nin: Array.from(PR_DONE_STATUSES) },
        "items.productId": product._id,
      })
        .populate("vendorId", "shopName name")
        .populate("items.productId", "name mainImage unit")
        .populate("pickupPartnerId", "name phone")
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      PurchaseRequest.find({
        vendorId,
        status: { $in: ["verified", "closed"] },
        "items.productId": product._id,
      })
        .populate("items.productId", "name")
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean(),
    ]);

    const mapContextRow = (row) => {
      const line = (row.items || []).find(
        (it) => String(it.productId?._id || it.productId) === String(product._id),
      ) || row.items?.[0];
      const phase = PR_IN_DELIVERY_STATUSES.has(row.status)
        ? "in_delivery"
        : PR_AWAITING_VENDOR_STATUSES.has(row.status)
          ? "awaiting_vendor"
          : row.status === "received_at_hub"
            ? "at_hub"
            : row.status === "exception"
              ? "exception"
              : "other";

      const quantity = Number(line?.shortageQty || line?.requiredQty || 0);
      const unitCost = Number(line?.vendorUnitCost || 0);
      return {
        _id: row._id,
        requestId: row.requestId,
        productName: line?.productId?.name || product.name,
        status: row.status,
        statusLabel: prStatusLabel(row.status),
        phase,
        quantity,
        unitCost,
        totalCost: toMoney(unitCost * quantity + Number(line?.gstAmount || 0)),
        vendorResponse: row.vendorResponse?.status || "pending",
        pickupPartner: row.pickupPartnerId
          ? {
              name: row.pickupPartnerId?.name || row.pickupPartnerName || "Pickup",
              phone: row.pickupPartnerId?.phone || "",
            }
          : null,
        notes: row.notes || "",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        isOpen: !PR_DONE_STATUSES.has(row.status),
      };
    };

    const open = openRequests.map(mapContextRow);
    const hasBlockingRequest = open.length > 0;
    const inDelivery = open.filter((r) => r.phase === "in_delivery");
    const awaitingVendor = open.filter((r) => r.phase === "awaiting_vendor");

    return handleResponse(res, 200, "Purchase request context loaded", {
      product: {
        _id: product._id,
        name: product.name,
        mainImage: product.mainImage,
        status: product.status,
        unit: product.unit,
        brand: product.brand,
        category: product.categoryId?.name || null,
        subcategory: product.subcategoryId?.name || null,
        sellerStock,
        supplyPrice,
        variants: (product.variants || []).map((v) => ({
          name: v.name,
          stock: Number(v.stock) || 0,
          price: Number(v.price ?? v.salePrice) || supplyPrice,
        })),
      },
      vendor: {
        _id: vendorId,
        shopName: product.sellerId?.shopName || product.sellerId?.name || "Vendor",
        name: product.sellerId?.name || "",
        phone: product.sellerId?.phone || "",
        isVerified: product.sellerId?.isVerified,
      },
      listingType,
      listingTypeLabel: isCatalogListing
        ? "Hub catalog listing"
        : "Seller-owned product",
      masterProduct: isCatalogListing
        ? {
            _id: product.masterProductId?._id || product.masterProductId,
            name: product.masterProductId?.name || "Master product",
            customerPrice:
              product.masterProductId?.salePrice ||
              product.masterProductId?.price ||
              null,
          }
        : null,
      openRequests: open,
      inDelivery,
      awaitingVendor,
      recentCompleted: recentCompleted.map(mapContextRow),
      hasBlockingRequest,
      canCreateRequest: sellerStock > 0 && !hasBlockingRequest,
      blockReason: hasBlockingRequest
        ? "An open purchase request already exists for this seller listing."
        : sellerStock <= 0
          ? "Seller has no stock available to procure."
          : null,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getPurchaseRequests = async (req, res) => {
  try {
    const {
      status,
      orderId,
      requestId,
      hubId = DEFAULT_HUB_ID,
      vendorId,
      productId,
      openOnly,
    } = req.query;
    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 100,
    });

    const query = {};
    if (hubId && hubId !== "all") query.hubId = String(hubId);
    if (status && status !== "all") query.status = status;
    if (orderId && mongoose.Types.ObjectId.isValid(orderId)) query.orderId = orderId;
    if (requestId) query.requestId = { $regex: String(requestId), $options: "i" };
    if (vendorId && mongoose.Types.ObjectId.isValid(vendorId)) {
      query.vendorId = vendorId;
    }
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      query["items.productId"] = productId;
    }
    if (String(openOnly || "").toLowerCase() === "true") {
      query.status = { $nin: Array.from(PR_DONE_STATUSES) };
    }

    const [items, total] = await Promise.all([
      PurchaseRequest.find(query)
        .populate("vendorId", "shopName name")
        .populate("items.productId", "name mainImage unit")
        .populate("pickupPartnerId", "name phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PurchaseRequest.countDocuments(query),
    ]);

    const mapped = items.map(mapRow);
    const openCount = mapped.filter((row) => row.isOpen).length;

    return handleResponse(res, 200, "Purchase requests fetched", {
      items: mapped,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      openCount,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const createManualPurchaseRequest = async (req, res) => {
  try {
    const {
      vendorId,
      productId,
      quantity,
      hubId = DEFAULT_HUB_ID,
      notes,
    } = req.body || {};

    if (!vendorId || !mongoose.Types.ObjectId.isValid(vendorId)) {
      return handleResponse(res, 400, "Valid vendorId is required");
    }
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return handleResponse(res, 400, "Valid productId is required");
    }

    const qty = Math.max(1, Number(quantity || 0));
    if (!Number.isFinite(qty) || qty <= 0) {
      return handleResponse(res, 400, "Valid quantity is required");
    }

    const [vendor, product] = await Promise.all([
      Seller.findById(vendorId).select("_id shopName name"),
      Product.findById(productId).select(
        "_id name status stock price salePrice purchasePrice gstRate variants",
      ),
    ]);

    if (!vendor) return handleResponse(res, 404, "Vendor not found");
    if (!product) return handleResponse(res, 404, "Product not found");

    const sellerStock = (() => {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      if (variants.length) {
        return variants.reduce((sum, v) => sum + (Number(v?.stock) || 0), 0);
      }
      return Math.max(0, Number(product.stock) || 0);
    })();

    if (sellerStock <= 0) {
      return handleResponse(
        res,
        400,
        `Cannot create PR: ${product.name} is out of stock at the vendor.`,
      );
    }

    const openDuplicate = await PurchaseRequest.findOne({
      vendorId: vendor._id,
      status: { $nin: Array.from(PR_DONE_STATUSES) },
      "items.productId": product._id,
    }).select("requestId status");

    if (openDuplicate) {
      return handleResponse(
        res,
        409,
        `Open purchase request ${openDuplicate.requestId} already exists for this product.`,
        { requestId: openDuplicate.requestId, status: openDuplicate.status },
      );
    }

    let requestId = generateRequestId();
    let retries = 0;
    while (retries < 10) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await PurchaseRequest.exists({ requestId });
      if (!exists) break;
      requestId = generateRequestId();
      retries += 1;
    }

    const unitCost = toMoney(product?.purchasePrice || product?.salePrice || product?.price || 0);

    const doc = await PurchaseRequest.create({
      requestId,
      orderId: null,
      hubId: String(hubId || DEFAULT_HUB_ID),
      vendorId: vendor._id,
      items: [
        {
          productId: product._id,
          requiredQty: qty,
          availableQtyAtHub: 0,
          shortageQty: qty,
          vendorUnitCost: unitCost,
          vendorQuotedPrice: unitCost,
          pricingStrategy: "manual_admin_request",
          gstRate: product.gstRate || 0,
          gstAmount: Math.round(unitCost * qty * ((product.gstRate || 0) / 100)),
        },
      ],
      status: "created",
      notes: String(notes || ""),
    });

    const hydrated = await PurchaseRequest.findById(doc._id)
      .populate("vendorId", "shopName name")
      .populate("items.productId", "name")
      .lean();

    return handleResponse(
      res,
      201,
      "Purchase request created successfully",
      mapRow(hydrated),
    );
  } catch (error) {
    if (error?.code === 11000) {
      return handleResponse(res, 400, "Duplicate purchase request id, retry");
    }
    return handleResponse(res, 500, error.message);
  }
};

export const updatePurchaseRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, eta } = req.body || {};

    if (!ALLOWED_STATUSES.has(String(status || ""))) {
      return handleResponse(res, 400, "Invalid status");
    }

    const doc = await PurchaseRequest.findById(id);
    if (!doc) return handleResponse(res, 404, "Purchase request not found");

    doc.status = status;
    if (notes !== undefined) doc.notes = String(notes || "");
    if (eta) doc.eta = new Date(eta);
    await doc.save();

    return handleResponse(res, 200, "Purchase request status updated", doc);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const assignPickupPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const { pickupPartnerId, pickupPartnerName } = req.body || {};

    const doc = await PurchaseRequest.findById(id).populate("items.productId", "name");
    if (!doc) return handleResponse(res, 404, "Purchase request not found");

    if (pickupPartnerId) {
      const partner = await PickupPartner.findById(pickupPartnerId).lean();
      if (!partner) return handleResponse(res, 404, "Pickup partner not found");
      const otp = await assignPickupToRequest(doc, partner);
      return handleResponse(res, 200, "Pickup partner assigned", {
        ...doc.toObject(),
        pickupOtp: otp,
        pickupOtpExpiresAt: doc.pickupOtpExpiresAt,
      });
    } else {
      doc.pickupPartnerId = null;
      doc.pickupPartnerName = String(pickupPartnerName || "").trim();
      doc.pickupOtpCode = undefined;
      doc.pickupOtpHash = undefined;
      doc.pickupOtpExpiresAt = undefined;
      doc.pickupOtpVerifiedAt = undefined;
      doc.status = "vendor_confirmed";
      await doc.save();
      return handleResponse(res, 200, "Pickup partner assignment cleared", doc);
    }
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const assignVendor = async (req, res) => {
  try {
    const { id } = req.params;
    const { vendorId } = req.body || {};
    if (!vendorId || !mongoose.Types.ObjectId.isValid(vendorId)) {
      return handleResponse(res, 400, "Valid vendorId is required");
    }

    const [doc, vendor] = await Promise.all([
      PurchaseRequest.findById(id),
      Seller.findById(vendorId).select("_id shopName name"),
    ]);
    if (!doc) return handleResponse(res, 404, "Purchase request not found");
    if (!vendor) return handleResponse(res, 404, "Vendor not found");

    doc.vendorId = vendor._id;
    if (doc.status === "cancelled") {
      doc.status = "created";
    }
    await doc.save();

    return handleResponse(res, 200, "Vendor assigned successfully", doc);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const receiveAtHub = async (req, res) => {
  try {
    const { id } = req.params;
    const { items, notes } = req.body || {};

    const pr = await PurchaseRequest.findById(id).populate("items.productId", "name");
    if (!pr) return handleResponse(res, 404, "Purchase request not found");
    if (!["picked", "hub_delivered", "pickup_assigned"].includes(String(pr.status))) {
      return handleResponse(
        res,
        400,
        "Request must be picked/hub_delivered before receiving at hub",
      );
    }

    const incomingItems = Array.isArray(items) ? items : [];
    const normalized = [];

    for (const line of pr.items || []) {
      const productId = String(line.productId?._id || line.productId);
      const incoming =
        incomingItems.find((it) => String(it.productId) === productId) || {};
      const expectedQty = Number(line.shortageQty || line.requiredQty || 0);
      const receivedQty = Math.max(
        0,
        Number(incoming.receivedQty ?? expectedQty ?? 0),
      );
      const damagedQty = Math.max(0, Number(incoming.damagedQty || 0));
      const acceptedQty = Math.max(0, receivedQty - damagedQty);
      const fallbackCost = toMoney(Number(line.vendorUnitCost || 0));
      const incomingCost = toMoney(
        incoming.purchaseUnitCost !== undefined ? incoming.purchaseUnitCost : fallbackCost,
      );

      // --- SELLER STOCK VALIDATION REMOVED (Handled at Pickup) ---
      const sellerId = pr.vendorId;
      const targetSellerProductId = line.selectedSellerProductId || productId;

      // --- HUB-FIRST LOGIC: Resolve Master ID for Inventory ---
      const sellerProductData = await Product.findById(productId).select('masterProductId ownerType');
      const resolvedMasterProductId = (sellerProductData?.ownerType === 'seller' && sellerProductData?.masterProductId) 
        ? String(sellerProductData.masterProductId) 
        : productId;

      const hubRow = await HubInventory.findOne({
        hubId: pr.hubId || DEFAULT_HUB_ID,
        productId: resolvedMasterProductId,
      });

      if (hubRow) {
        const prevQty = Math.max(0, Number(hubRow.availableQty || 0));
        const prevAvgCost = Math.max(0, Number(hubRow.avgPurchaseCost || hubRow.lastPurchaseCost || 0));
        const nextQty = prevQty + acceptedQty;
        const weightedAvgCost = nextQty > 0 
          ? toMoney((prevQty * prevAvgCost + acceptedQty * incomingCost) / nextQty) 
          : incomingCost;
          
        const masterProduct = await Product.findById(resolvedMasterProductId).select('price salePrice');
        const sellPrice = masterProduct?.price || masterProduct?.salePrice || incomingCost;

        hubRow.reservedQty = Math.max(0, Number(hubRow.reservedQty || 0) + acceptedQty);
        hubRow.lastPurchaseCost = incomingCost;
        hubRow.avgPurchaseCost = weightedAvgCost;
        hubRow.sellPrice = sellPrice;
        hubRow.priceUpdatedAt = new Date();
        if (hubRow.availableQty <= 0) hubRow.status = "out_of_stock";
        else if (hubRow.availableQty <= Number(hubRow.reorderLevel || 0))
          hubRow.status = "low_stock";
        else hubRow.status = "healthy";
        await hubRow.save();
      } else {
        const masterProduct = await Product.findById(resolvedMasterProductId).select('price salePrice');
        const sellPrice = masterProduct?.price || masterProduct?.salePrice || incomingCost;

        await HubInventory.create({
          hubId: pr.hubId || DEFAULT_HUB_ID,
          productId: resolvedMasterProductId,
          availableQty: 0,
          reservedQty: acceptedQty,
          reorderLevel: 10,
          lastPurchaseCost: incomingCost,
          avgPurchaseCost: incomingCost,
          sellPrice,
          priceUpdatedAt: new Date(),
          status: acceptedQty > 0 ? "healthy" : "out_of_stock",
        });
      }

      normalized.push({
        productId: resolvedMasterProductId, // Store the resolved Master ID in the inward record
        sellerProductId: productId, // Keep track of which seller item it was
        expectedQty,
        receivedQty,
        damagedQty,
        purchaseUnitCost: incomingCost,
        acceptedQty,
        qualityStatus: incoming.qualityStatus || "ok",
      });
    }

    await HubInward.create({
      purchaseRequestId: pr._id,
      hubId: pr.hubId || DEFAULT_HUB_ID,
      receivedItems: normalized,
      verificationStatus: "pending",
      receivedBy: req.user?.id || null,
      receivedByModel: "Admin",
      notes: String(notes || ""),
    });

    pr.status = "received_at_hub";
    await pr.save();

    // Trace: Create a PENDING transaction immediately upon receipt for financial visibility
    try {
      let totalValue = normalized.reduce((acc, item) => acc + (item.acceptedQty * item.purchaseUnitCost), 0);
      if (totalValue > 0) {
        await Transaction.create({
          user: pr.vendorId,
          userModel: "Seller",
          order: pr.orderId || undefined,
          type: "Supply Earning",
          amount: totalValue,
          status: "Pending", // Visible but not yet withdrawable
          reference: `PR-REC-${pr.requestId}`,
          meta: {
            purchaseRequestId: pr._id,
            receivedAt: new Date(),
          }
        });
        console.log(`[Trace] Created Pending Supply Earning for Seller ${pr.vendorId}: ₹${totalValue}`);
      }
    } catch (txnErr) {
      console.error("[receiveAtHub] Transaction creation failed:", txnErr.message);
    }

    if (pr.pickupPartnerId) {
      const openCount = await PurchaseRequest.countDocuments({
        pickupPartnerId: pr.pickupPartnerId,
        status: { $in: ["pickup_assigned", "picked"] },
      });
      if (openCount === 0) {
        await PickupPartner.findByIdAndUpdate(pr.pickupPartnerId, {
          $set: { status: "available" },
        });
      }
    }

    return handleResponse(res, 200, "Items received at hub", { purchaseRequestId: pr._id });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const verifyInward = async (req, res) => {
  try {
    const { id } = req.params;
    const { verified = true, notes } = req.body || {};

    const pr = await PurchaseRequest.findById(id);
    if (!pr) return handleResponse(res, 404, "Purchase request not found");

    const inward = await HubInward.findOne({ purchaseRequestId: pr._id }).sort({
      createdAt: -1,
    });
    if (!inward) {
      return handleResponse(res, 404, "No hub inward record found");
    }

    inward.verificationStatus = verified ? "verified" : "rejected";
    inward.verifiedBy = req.user?.id || null;
    inward.verifiedByModel = "Admin";
    inward.verificationNotes = String(notes || "");
    await inward.save();

    pr.status = verified ? "verified" : "cancelled";
    if (notes !== undefined) pr.notes = String(notes || "");
    await pr.save();

    // Move stock from Reserved to Available in Hub Inventory
    if (verified && inward.receivedItems) {
      for (const item of inward.receivedItems) {
        const productId = String(item.productId?._id || item.productId);
        const acceptedQty = Number(item.acceptedQty || 0);

        if (acceptedQty > 0) {
          const hubRow = await HubInventory.findOne({
            hubId: pr.hubId || DEFAULT_HUB_ID,
            productId
          });

          if (hubRow) {
            // Deduct from reserved and add to available
            hubRow.reservedQty = Math.max(0, (hubRow.reservedQty || 0) - acceptedQty);
            hubRow.availableQty = (hubRow.availableQty || 0) + acceptedQty;
            
            // Re-sync price with Master Catalog just in case
            const masterProduct = await Product.findById(productId);
            if (masterProduct) {
              hubRow.sellPrice = masterProduct.price || masterProduct.salePrice || hubRow.sellPrice;
              
              // Also sync Master Product stock
              masterProduct.stock = hubRow.availableQty;
              await masterProduct.save();
              
              // Propagation: Sync Master Price to all linked seller products (Downward Sync)
              // This ensures if Admin changed master price during inwarding, it propagates.
              const { propagatePriceUpdates } = await import('./productController.js');
              if (propagatePriceUpdates) {
                 await propagatePriceUpdates(masterProduct);
              }
            }

            // Update status based on new available quantity
            if (hubRow.availableQty <= 0) hubRow.status = "out_of_stock";
            else if (hubRow.availableQty <= Number(hubRow.reorderLevel || 0)) hubRow.status = "low_stock";
            else hubRow.status = "healthy";

            await hubRow.save();
            console.log(`[Inward] Verified stock for ${productId}: Moved ${acceptedQty} to Available. New total: ${hubRow.availableQty}`);
          }
        }
      }
    }

    // Financial Settlement: If verified, update the Pending transaction to 'Settled'
    if (verified && pr.vendorId) {
      const existingTxn = await Transaction.findOne({
        user: pr.vendorId,
        reference: `PR-REC-${pr.requestId}`,
        status: "Pending"
      });

      if (existingTxn) {
        existingTxn.status = "Settled";
        existingTxn.meta.verifiedAt = new Date();
        await existingTxn.save();
        console.log(`[Settlement] Updated transaction to Settled for Seller ${pr.vendorId}: PR ${pr.requestId}`);
      } else {
        // Fallback: If for some reason receipt didn't create a txn, create it now
        let totalProcurementCost = (inward.receivedItems || []).reduce((acc, item) => {
          return acc + (Number(item.acceptedQty || 0) * Number(item.purchaseUnitCost || 0));
        }, 0);

        if (totalProcurementCost > 0) {
          await Transaction.create({
            user: pr.vendorId,
            userModel: "Seller",
            order: pr.orderId || undefined,
            type: "Supply Earning",
            amount: totalProcurementCost,
            status: "Settled",
            reference: `PR-SETTLE-${pr.requestId}`,
            meta: { purchaseRequestId: pr._id, verifiedAt: new Date() }
          });
        }
      }
    }

    // If all purchase requests for this order are resolved, move order to packing-ready stage.
    const [parentOrder, siblingRequests] = await Promise.all([
      Order.findById(pr.orderId),
      PurchaseRequest.find({ orderId: pr.orderId }).select("status").lean(),
    ]);
    if (parentOrder) {
      const allDone =
        siblingRequests.length > 0 &&
        siblingRequests.every((row) => PR_DONE_STATUSES.has(String(row.status)));
      if (allDone) {
        parentOrder.hubStatus = "ready_for_packing";
        parentOrder.procurementRequired = false;
        if (parentOrder.workflowVersion >= 2) {
          parentOrder.workflowStatus = WORKFLOW_STATUS.SELLER_ACCEPTED;
        }
        if (parentOrder.status === "pending") {
          parentOrder.status = "confirmed";
        }
        await parentOrder.save();
        if (verified && parentOrder.workflowVersion >= 2 && parentOrder.hubFlowEnabled) {
          try {
            await startHubDeliverySearchAtomic(parentOrder.orderId);
          } catch (e) {
            console.warn(
              `[verifyInward] auto dispatch skipped for ${parentOrder.orderId}:`,
              e.message,
            );
          }
        }
      }
    }

    return handleResponse(res, 200, "Hub inward verification updated", {
      purchaseRequestId: pr._id,
      status: pr.status,
      verificationStatus: inward.verificationStatus,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getSellerPurchaseRequests = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const { status = "all" } = req.query || {};

    const query = { vendorId: sellerId };
    if (status !== "all") {
      query.status = String(status);
    }

    // We fetch and then filter to ensure we only show requests with VALID existing orders
    const rows = await PurchaseRequest.find(query)
      .populate({
        path: "orderId",
        select: "orderId status workflowStatus",
      })
      .populate("items.productId", "name")
      .populate("pickupPartnerId", "name phone")
      .sort({ createdAt: -1 })
      .lean();

    // Filter out requests where order is missing or cancelled at the order level
    const filteredRows = rows.filter(row => {
      // If it's a manual admin PR (no orderId), show it
      if (!row.orderId && !row.requestId.includes("ORD")) return true;
      
      // If order is missing from DB or order status is cancelled, hide it from seller
      if (!row.orderId || row.orderId.status === "cancelled") return false;
      
      return true;
    });

    return handleResponse(res, 200, "Seller purchase requests fetched", {
      items: filteredRows.map(mapSellerRow),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const respondSellerPurchaseRequest = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const { id } = req.params;
    const {
      action = "accept",
      notes = "",
      rejectionReason = "",
      items = [],
    } = req.body || {};

    const pr = await PurchaseRequest.findOne({ _id: id, vendorId: sellerId }).populate(
      "items.productId",
      "name",
    );
    if (!pr) return handleResponse(res, 404, "Purchase request not found");

    if (!["created", "vendor_confirmed", "pickup_assigned"].includes(String(pr.status))) {
      return handleResponse(
        res,
        400,
        "Purchase request is not open for seller response",
      );
    }

    const normalizedAction = String(action).toLowerCase();
    if (!["accept", "reject", "partial"].includes(normalizedAction)) {
      return handleResponse(res, 400, "Invalid action");
    }

    if (normalizedAction === "reject") {
      pr.vendorResponse = {
        status: "rejected",
        respondedAt: new Date(),
        rejectionReason: String(rejectionReason || "Rejected by seller"),
        notes: String(notes || ""),
      };
      pr.status = "exception";
      pr.exceptionReason = String(rejectionReason || "Rejected by seller");
      await pr.save();
      return handleResponse(res, 200, "Purchase request rejected", mapSellerRow(pr.toObject()));
    }

    const incomingMap = new Map(
      (Array.isArray(items) ? items : [])
        .filter((row) => row && row.productId != null)
        .map((row) => [String(row.productId), Number(row.committedQty || 0)]),
    );

    let fullyCommitted = true;
    let anyCommitted = false;
    pr.items = (pr.items || []).map((line) => {
      const shortage = Number(line.shortageQty || 0);
      let committedQty = shortage;
      const key = String(line.productId?._id || line.productId);
      if (incomingMap.has(key)) {
        committedQty = Math.min(shortage, Math.max(0, incomingMap.get(key)));
      } else if (normalizedAction === "partial") {
        committedQty = Number(line.committedQty || 0);
      }
      if (committedQty < shortage) fullyCommitted = false;
      if (committedQty > 0) anyCommitted = true;
      return { ...line.toObject(), committedQty };
    });

    const responseStatus = fullyCommitted
      ? "accepted"
      : anyCommitted
        ? "partial"
        : "rejected";

    pr.vendorResponse = {
      status: responseStatus,
      respondedAt: new Date(),
      rejectionReason: responseStatus === "rejected" ? "No quantity committed" : "",
      notes: String(notes || ""),
    };
    pr.status = "vendor_confirmed";
    pr.exceptionReason = "";
    await pr.save();

    // --- STEP 10: AUTOMATIC PICKUP ASSIGNMENT ---
    if (responseStatus === "accepted" || responseStatus === "partial") {
      try {
        const bestPartner = await pickBestPickupPartner(pr.hubId);
        if (bestPartner) {
          await assignPickupToRequest(pr, bestPartner);
          console.log(`[Step 10] Automatically assigned Pickup Partner ${bestPartner.name} to PR ${pr.requestId}`);
        } else {
          console.log(`[Step 10] No available Pickup Partners found for Hub ${pr.hubId}. Admin must assign manually.`);
        }
      } catch (assignErr) {
        console.warn("[Step 10] Automatic assignment failed:", assignErr.message);
      }
    }

    return handleResponse(res, 200, "Seller response saved and pickup request triggered", mapSellerRow(pr.toObject()));
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const markSellerRequestReady = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const { id } = req.params;
    const { notes = "" } = req.body || {};

    const pr = await PurchaseRequest.findOne({ _id: id, vendorId: sellerId }).lean();
    if (!pr) return handleResponse(res, 404, "Purchase request not found");

    if (!["created", "vendor_confirmed", "pickup_assigned"].includes(String(pr.status))) {
      return handleResponse(
        res,
        400,
        "Request must be created/vendor_confirmed before marking ready",
      );
    }

    const doc = await PurchaseRequest.findById(id).populate("items.productId", "name");
    if (!doc) return handleResponse(res, 404, "Purchase request not found");

    doc.vendorReadyAt = new Date();
    doc.vendorReadyNotes = String(notes || "");
    if (String(doc.vendorResponse?.status || "pending") === "pending") {
      doc.vendorResponse = {
        status: "accepted",
        respondedAt: new Date(),
        rejectionReason: "",
        notes: String(notes || ""),
      };
      if (String(doc.status) === "created") {
        doc.status = "vendor_confirmed";
      }
    }
    let autoAssigned = false;

    if (!doc.pickupPartnerId) {
      const partner = await pickBestPickupPartner(doc.hubId || DEFAULT_HUB_ID);
      if (partner) {
        await assignPickupToRequest(doc, partner);
        autoAssigned = true;
      } else {
        doc.status = "vendor_confirmed";
        await doc.save();
      }
    } else {
      await doc.save();
    }

    const updated = await PurchaseRequest.findById(id)
      .populate("orderId", "orderId")
      .populate("items.productId", "name")
      .populate("pickupPartnerId", "name phone")
      .lean();

    return handleResponse(res, 200, "Marked ready for pickup", {
      ...mapSellerRow(updated),
      autoPickupAssigned: autoAssigned,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const confirmSellerHandover = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const { id } = req.params;
    const { otp, notes = "" } = req.body || {};

    if (!otp) return handleResponse(res, 400, "Pickup OTP is required");

    const pr = await PurchaseRequest.findOne({ _id: id, vendorId: sellerId }).populate(
      "items.productId",
      "name",
    );
    if (!pr) return handleResponse(res, 404, "Purchase request not found");

    if (String(pr.status) !== "pickup_assigned") {
      return handleResponse(
        res,
        400,
        "Pickup partner must be assigned before handover",
      );
    }

    const expectedHash = pr.pickupOtpHash || "";
    if (!expectedHash || expectedHash !== hashPickupOtp(otp)) {
      return handleResponse(res, 400, "Invalid pickup OTP");
    }
    if (pr.pickupOtpExpiresAt && new Date(pr.pickupOtpExpiresAt) < new Date()) {
      return handleResponse(res, 400, "Pickup OTP expired");
    }

    pr.vendorHandover = {
      confirmedAt: new Date(),
      otpVerifiedAt: new Date(),
      notes: String(notes || ""),
    };
    pr.pickupOtpVerifiedAt = new Date();
    await pr.save();

    return handleResponse(
      res,
      200,
      "Handover OTP verified. Waiting pickup partner confirmation.",
      mapSellerRow(pr.toObject()),
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
