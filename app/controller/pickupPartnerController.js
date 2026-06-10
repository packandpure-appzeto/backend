import PickupPartner from "../models/pickupPartner.js";
import PurchaseRequest from "../models/purchaseRequest.js";
import Delivery from "../models/delivery.js";

async function resolvePickupPartnerId(user) {
  if (!user) return null;
  if (user.role === 'pickup_partner') return user.id;
  if (user.role === 'delivery') {
    const delivery = await Delivery.findById(user.id).select('phone').lean();
    if (delivery && delivery.phone) {
      const pickupPartner = await PickupPartner.findOne({ phone: delivery.phone }).select('_id').lean();
      if (pickupPartner) return String(pickupPartner._id);
    }
  }
  return null;
}
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";
import { distanceMeters } from "../utils/geoUtils.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const DEFAULT_HUB_ID = process.env.DEFAULT_HUB_ID || "MAIN_HUB";
const PICKUP_RADIUS_M = Math.max(50, Number(process.env.PICKUP_PARTNER_VENDOR_RADIUS_METERS || 1000000));
const HUB_RADIUS_M = Math.max(50, Number(process.env.PICKUP_PARTNER_HUB_RADIUS_METERS || 1000000));

const hashPickupOtp = (otp) =>
  crypto.createHash("sha256").update(String(otp)).digest("hex");

const parseHubCoordinate = (...keys) => {
  for (const key of keys) {
    const raw = process.env[key];
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const buildPartnerToken = (partner) =>
  jwt.sign(
    { id: partner._id, role: "pickup_partner" },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );

const mapStatusLabel = (status) => {
  if (status === "active") return "Active";
  if (status === "inactive") return "Inactive";
  return "Available";
};

const serializeRow = (row, assignmentStats = new Map()) => {
  const stat = assignmentStats.get(String(row._id)) || {
    totalAssigned: 0,
    activeAssigned: 0,
  };
  return {
    _id: row._id,
    partnerName: row.name,
    phone: row.phone,
    vehicleType: row.vehicleType,
    hubId: row.hubId,
    status: mapStatusLabel(row.status),
    statusRaw: row.status,
    isActive: row.isActive,
    isVerified: row.isVerified,
    assignedPickups: Number(stat.totalAssigned || 0),
    activeAssignedPickups: Number(stat.activeAssigned || 0),
    paymentType: row.paymentType || "per_trip",
    salaryAmount: row.salaryAmount || 0,
    perKmRate: row.perKmRate || 0,
    baseTripRate: row.baseTripRate || 0,
    walletBalance: row.walletBalance || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const getPickupPartners = async (req, res) => {
  try {
    const { status, search, hubId = DEFAULT_HUB_ID } = req.query;
    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 100,
    });

    const query = { hubId: String(hubId) };
    if (status && status !== "all") query.status = String(status).toLowerCase();
    if (search) {
      query.$or = [
        { name: { $regex: String(search), $options: "i" } },
        { phone: { $regex: String(search), $options: "i" } },
      ];
    }

    const [rows, total] = await Promise.all([
      PickupPartner.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PickupPartner.countDocuments(query),
    ]);

    const partnerIds = rows.map((r) => r._id);
    const assignment = await PurchaseRequest.aggregate([
      { $match: { pickupPartnerId: { $in: partnerIds } } },
      {
        $group: {
          _id: "$pickupPartnerId",
          totalAssigned: { $sum: 1 },
          activeAssigned: {
            $sum: {
              $cond: [{ $in: ["$status", ["pickup_assigned", "picked"]] }, 1, 0],
            },
          },
        },
      },
    ]);
    const statsMap = new Map(
      assignment.map((a) => [String(a._id), { totalAssigned: a.totalAssigned, activeAssigned: a.activeAssigned }]),
    );

    return handleResponse(res, 200, "Pickup partners fetched", {
      items: rows.map((row) => serializeRow(row, statsMap)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const createPickupPartner = async (req, res) => {
  try {
    const { 
      partnerName, phone, vehicleType, hubId = DEFAULT_HUB_ID,
      paymentType, salaryAmount, perKmRate, baseTripRate 
    } = req.body || {};
    if (!partnerName || !String(partnerName).trim()) {
      return handleResponse(res, 400, "partnerName is required");
    }
    if (!phone || !String(phone).trim()) {
      return handleResponse(res, 400, "phone is required");
    }

    const doc = await PickupPartner.create({
      name: String(partnerName).trim(),
      phone: String(phone).trim(),
      vehicleType: String(vehicleType || "bike").trim(),
      hubId: String(hubId),
      status: "available",
      isActive: true,
      isVerified: true,
      paymentType: paymentType || "per_trip",
      salaryAmount: Number(salaryAmount || 0),
      perKmRate: Number(perKmRate || 0),
      baseTripRate: Number(baseTripRate || 0),
    });

    return handleResponse(res, 201, "Pickup partner created", serializeRow(doc.toObject()));
  } catch (error) {
    if (error?.code === 11000) {
      return handleResponse(res, 400, "Phone already exists");
    }
    return handleResponse(res, 500, error.message);
  }
};

export const updatePickupPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      partnerName, phone, vehicleType, status, isActive,
      paymentType, salaryAmount, perKmRate, baseTripRate
    } = req.body || {};

    const doc = await PickupPartner.findById(id);
    if (!doc) return handleResponse(res, 404, "Pickup partner not found");

    if (partnerName !== undefined) doc.name = String(partnerName).trim();
    if (phone !== undefined) doc.phone = String(phone).trim();
    if (vehicleType !== undefined) doc.vehicleType = String(vehicleType).trim();
    if (status !== undefined) doc.status = String(status).toLowerCase();
    if (isActive !== undefined) doc.isActive = Boolean(isActive);
    if (req.body.isVerified !== undefined) doc.isVerified = Boolean(req.body.isVerified);
    
    if (paymentType !== undefined) doc.paymentType = paymentType;
    if (salaryAmount !== undefined) doc.salaryAmount = Number(salaryAmount);
    if (perKmRate !== undefined) doc.perKmRate = Number(perKmRate);
    if (baseTripRate !== undefined) doc.baseTripRate = Number(baseTripRate);

    await doc.save();
    return handleResponse(res, 200, "Pickup partner updated", serializeRow(doc.toObject()));
  } catch (error) {
    if (error?.code === 11000) {
      return handleResponse(res, 400, "Phone already exists");
    }
    return handleResponse(res, 500, error.message);
  }
};

export const updatePickupPartnerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    const normalized = String(status || "").toLowerCase();
    if (!["available", "active", "inactive"].includes(normalized)) {
      return handleResponse(res, 400, "Invalid status");
    }

    const doc = await PickupPartner.findById(id);
    if (!doc) return handleResponse(res, 404, "Pickup partner not found");

    doc.status = normalized;
    doc.isActive = normalized !== "inactive";
    await doc.save();

    return handleResponse(res, 200, "Pickup partner status updated", serializeRow(doc.toObject()));
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const sendPickupPartnerLoginOtp = async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone || !String(phone).trim()) {
      return handleResponse(res, 400, "phone is required");
    }

    const partner = await PickupPartner.findOne({ phone: String(phone).trim() }).select("+otp +otpExpiry");
    if (!partner || !partner.isActive || !partner.isVerified) {
      return handleResponse(res, 404, "Pickup partner not found or inactive");
    }

    const otp = generateOTP();
    partner.otp = otp;
    partner.otpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    await partner.save();

    if (useRealSMS()) {
      console.log("Pickup Partner OTP (real SMS mode):", otp);
    } else {
      console.log("Pickup Partner OTP (mock mode): use 1234");
    }

    return handleResponse(res, 200, "OTP sent successfully");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const verifyPickupPartnerOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body || {};
    if (!phone || !otp) {
      return handleResponse(res, 400, "phone and otp are required");
    }

    const partner = await PickupPartner.findOne({
      phone: String(phone).trim(),
      otp: String(otp).trim(),
      otpExpiry: { $gt: new Date() },
    }).select("+otp +otpExpiry");

    if (!partner) {
      return handleResponse(res, 400, "Invalid or expired OTP");
    }

    partner.otp = undefined;
    partner.otpExpiry = undefined;
    partner.lastLogin = new Date();
    partner.status = partner.status === "inactive" ? "inactive" : "active";
    await partner.save();

    const token = buildPartnerToken(partner);
    return handleResponse(res, 200, "Login successful", {
      token,
      partner: {
        _id: partner._id,
        name: partner.name,
        phone: partner.phone,
        vehicleType: partner.vehicleType,
        hubId: partner.hubId,
        role: "pickup_partner",
      },
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getPickupPartnerProfile = async (req, res) => {
  try {
    const partnerId = req.user?.id;
    const partner = await PickupPartner.findById(partnerId).lean();
    if (!partner) {
      return handleResponse(res, 404, "Pickup partner not found");
    }

    return handleResponse(res, 200, "Pickup partner profile fetched", {
      _id: partner._id,
      name: partner.name,
      phone: partner.phone,
      vehicleType: partner.vehicleType,
      hubId: partner.hubId,
      status: partner.status,
      isActive: partner.isActive,
      walletBalance: partner.walletBalance || 0,
      baseTripRate: partner.baseTripRate || 0,
      perKmRate: partner.perKmRate || 0,
      paymentType: partner.paymentType || "per_trip",
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const updatePickupPartnerProfile = async (req, res) => {
  try {
    const partnerId = req.user?.id;
    const { name, vehicleType, address, location } = req.body || {};

    const partner = await PickupPartner.findById(partnerId);
    if (!partner) {
      return handleResponse(res, 404, "Pickup partner not found");
    }

    if (name !== undefined) partner.name = String(name).trim();
    if (vehicleType !== undefined) partner.vehicleType = String(vehicleType).trim();
    if (address !== undefined) partner.address = String(address).trim();
    if (location !== undefined) partner.location = location;

    await partner.save();

    return handleResponse(res, 200, "Profile updated successfully", {
      _id: partner._id,
      name: partner.name,
      phone: partner.phone,
      vehicleType: partner.vehicleType,
      hubId: partner.hubId,
      status: partner.status,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getMyPickupAssignments = async (req, res) => {
  try {
    const partnerId = await resolvePickupPartnerId(req.user);
    if (!partnerId) return handleResponse(res, 403, "No linked PickupPartner account found. Please ask Admin to create one with the same phone number.");
    const { status = "active" } = req.query || {};

    const query = { pickupPartnerId: partnerId };
    if (status === "active") {
      query.status = { $in: ["pickup_assigned", "picked", "hub_delivered"] };
    } else if (status !== "all") {
      query.status = status;
    }

    const rows = await PurchaseRequest.find(query)
      .populate("vendorId", "shopName name phone location")
      .populate("items.productId", "name sku weight unit")
      .sort({ createdAt: -1 })
      .lean();

    const items = rows.map((row) => ({
      _id: row._id,
      requestId: row.requestId,
      orderId: row.orderId,
      status: row.status,
      vendor: {
        id: row.vendorId?._id || row.vendorId || null,
        name: row.vendorId?.shopName || row.vendorId?.name || "Vendor",
        phone: row.vendorId?.phone || "",
        location: row.vendorId?.location || null,
      },
      products: (row.items || []).map((i) => ({
        productId: i.productId?._id || i.productId,
        name: i.productId?.name || "Product",
        sku: i.productId?.sku || "",
        weight: i.productId?.weight || "",
        unit: i.productId?.unit || "",
        qty: Number(i.shortageQty || i.requiredQty || 0),
      })),
      pickupOtpRequired: row.status === "pickup_assigned",
      pickupOtp:
        row.status === "pickup_assigned" &&
        (!row.pickupOtpExpiresAt || new Date(row.pickupOtpExpiresAt) > new Date())
          ? String(row.pickupOtpCode || "")
          : "",
      pickupOtpExpiresAt: row.pickupOtpExpiresAt || null,
      notes: row.notes || "",
      eta: row.eta || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return handleResponse(res, 200, "Pickup assignments fetched", { items });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const markAssignmentPicked = async (req, res) => {
  try {
    const partnerId = await resolvePickupPartnerId(req.user);
    if (!partnerId) return handleResponse(res, 403, "No linked PickupPartner account found.");
    const { id } = req.params;
    const { otp, lat, lng, notes, vendorImageUrl } = req.body || {};
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return handleResponse(res, 400, "Valid lat/lng required");
    }
    if (!otp) {
      return handleResponse(res, 400, "Pickup OTP is required");
    }

    const pr = await PurchaseRequest.findOne({
      _id: id,
      pickupPartnerId: partnerId,
      status: "pickup_assigned",
    }).populate("vendorId", "location");

    if (!pr) {
      return handleResponse(res, 404, "Pickup assignment not found");
    }

    if (!pr.pickupOtpVerifiedAt && !pr.vendorHandover?.otpVerifiedAt) {
      return handleResponse(res, 400, "Seller has not verified the handover OTP yet. Please ask the seller to verify the OTP first.");
    }

    const expectedHash = pr.pickupOtpHash || "";
    if (!expectedHash || expectedHash !== hashPickupOtp(otp)) {
      return handleResponse(res, 400, "Invalid pickup OTP");
    }
    if (pr.pickupOtpExpiresAt && new Date(pr.pickupOtpExpiresAt) < new Date()) {
      return handleResponse(res, 400, "Pickup OTP expired");
    }

    const coords = pr.vendorId?.location?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      const [vlng, vlat] = coords;
      const d = distanceMeters(latitude, longitude, vlat, vlng);
      if (d > PICKUP_RADIUS_M) {
        return handleResponse(res, 400, `Too far from vendor (>${PICKUP_RADIUS_M}m)`);
      }
    }

    pr.status = "picked";
    pr.pickupOtpCode = undefined;
    pr.pickupOtpHash = undefined;
    pr.pickupOtpExpiresAt = undefined;
    pr.pickupOtpVerifiedAt = new Date();
    pr.pickupProof = {
      pickedAt: new Date(),
      pickedBy: partnerId,
      vendorImageUrl: String(vendorImageUrl || ""),
      notes: String(notes || ""),
      location: { lat: latitude, lng: longitude },
    };
    await pr.save();

    // --- DEDUCT SELLER STOCK ---
    try {
      const Product = (await import("../models/product.js")).default;
      for (const item of pr.items) {
        if (item.productId && item.shortageQty > 0) {
          // We must find the seller-specific product, not the master one.
          // The PR's items often have the Master Product ID, but we need to find 
          // the Seller's version of it to deduct stock.
          const sellerProduct = await Product.findOne({
            sellerId: pr.vendorId?._id || pr.vendorId,
            $or: [
              { _id: item.productId },
              { masterProductId: item.productId }
            ]
          });

          if (sellerProduct) {
            const deduction = Number(item.shortageQty);
            const currentStock = Number(sellerProduct.stock || 0);
            
            if (currentStock < deduction) {
              // If stock is less than needed, just set it to 0 (don't go negative)
              await Product.findByIdAndUpdate(sellerProduct._id, { $set: { stock: 0 } });
              console.log(`[InventorySync] Stock was insufficient (${currentStock}). Set to 0 for product ${sellerProduct._id}`);
            } else {
              await Product.findByIdAndUpdate(sellerProduct._id, {
                $inc: { stock: -deduction }
              });
              console.log(`[InventorySync] Deducted ${deduction} from Seller ${pr.vendorId} for product ${sellerProduct._id}`);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[InventorySync] Failed to deduct seller stock:", err.message);
    }

    return handleResponse(res, 200, "Pickup marked successfully", pr);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const markAssignmentHubDelivered = async (req, res) => {
  try {
    const partnerId = await resolvePickupPartnerId(req.user);
    if (!partnerId) return handleResponse(res, 403, "No linked PickupPartner account found.");
    const { id } = req.params;
    const { lat, lng, notes, hubImageUrl } = req.body || {};
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return handleResponse(res, 400, "Valid lat/lng required");
    }

    const pr = await PurchaseRequest.findOne({
      _id: id,
      pickupPartnerId: partnerId,
      status: "picked",
    });

    if (!pr) {
      return handleResponse(res, 404, "Picked assignment not found");
    }

    const hubLat = parseHubCoordinate("HUB_LOCATION_LAT", "HUB_LAT", "DEFAULT_HUB_LAT");
    const hubLng = parseHubCoordinate("HUB_LOCATION_LNG", "HUB_LNG", "DEFAULT_HUB_LNG");
    if (Number.isFinite(hubLat) && Number.isFinite(hubLng)) {
      const d = distanceMeters(latitude, longitude, hubLat, hubLng);
      if (d > HUB_RADIUS_M) {
        return handleResponse(res, 400, `Too far from hub (>${HUB_RADIUS_M}m)`);
      }
    }

    pr.status = "hub_delivered";
    pr.hubDropProof = {
      droppedAt: new Date(),
      droppedBy: partnerId,
      hubImageUrl: String(hubImageUrl || ""),
      notes: String(notes || ""),
      location: { lat: latitude, lng: longitude },
    };
    await pr.save();

    // --- CALCULATE EARNINGS ---
    try {
      const partner = await PickupPartner.findById(partnerId);
      if (partner) {
        let earnings = 0;
        if (partner.paymentType === "per_trip") {
          // Calculate distance between Vendor and Hub
          const prPopulated = await PurchaseRequest.findById(id).populate("vendorId", "location");
          const vCoords = prPopulated.vendorId?.location?.coordinates;
          if (Array.isArray(vCoords) && vCoords.length >= 2) {
            const [vlng, vlat] = vCoords;
            const distanceKm = distanceMeters(latitude, longitude, vlat, vlng) / 1000;
            earnings = partner.baseTripRate + (distanceKm * partner.perKmRate);
          } else {
            earnings = partner.baseTripRate; // Fallback to base rate
          }
        }
        // For 'salary' based partners, we don't add to wallet balance automatically per trip,
        // or we can add a 'bonus' if desired. For now, we only auto-credit per_trip partners.
        
        if (earnings > 0) {
          partner.walletBalance = (partner.walletBalance || 0) + earnings;
          await partner.save();
          console.log(`[Payout] Credited ₹${earnings.toFixed(2)} to Pickup Partner ${partnerId} (Type: ${partner.paymentType})`);
        }
      }
    } catch (err) {
      console.warn("[Payout] Failed to calculate earnings:", err.message);
    }

    return handleResponse(res, 200, "Marked delivered at hub", pr);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const requestPickupWithdrawal = async (req, res) => {
  try {
    const partnerId = req.user?.id;
    const { amount, notes } = req.body || {};
    const reqAmount = Number(amount);

    if (!reqAmount || reqAmount <= 0) {
      return handleResponse(res, 400, "Valid amount required");
    }

    const partner = await PickupPartner.findById(partnerId);
    if (!partner) return handleResponse(res, 404, "Partner not found");

    if ((partner.walletBalance || 0) < reqAmount) {
      return handleResponse(res, 400, "Insufficient wallet balance");
    }

    // Use dynamic import for Transaction to avoid circular deps if any
    const Transaction = (await import("../models/transaction.js")).default;
    
    // Create Pending Withdrawal Transaction
    const txn = await Transaction.create({
      user: partnerId,
      userModel: "PickupPartner",
      type: "Withdrawal",
      amount: -reqAmount, // Negative because money is going out
      status: "Pending",
      reference: `WITHDRAW-${partnerId.slice(-4)}-${Date.now()}`,
      meta: { notes, requestedAt: new Date() }
    });

    // Deduct from balance
    partner.walletBalance = (partner.walletBalance || 0) - reqAmount;
    await partner.save();

    return handleResponse(res, 201, "Withdrawal request submitted", txn);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getMyWithdrawals = async (req, res) => {
  try {
    const partnerId = req.user?.id;
    const Transaction = (await import("../models/transaction.js")).default;
    
    const rows = await Transaction.find({
      user: partnerId,
      userModel: "PickupPartner",
      type: "Withdrawal"
    }).sort({ createdAt: -1 }).lean();

    return handleResponse(res, 200, "Withdrawals fetched", { items: rows });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const uploadPickupProofImage = async (req, res) => {
  try {
    const partnerId = req.user?.id;
    if (!partnerId) return handleResponse(res, 401, "Unauthorized");

    const { type = "vendor" } = req.query || {};
    const normalized = String(type || "vendor").toLowerCase();
    const folder = normalized === "hub" ? "pickup_hub_proofs" : "pickup_vendor_proofs";

    if (!req.file?.buffer) {
      return handleResponse(res, 400, "image file is required");
    }

    const url = await uploadToCloudinary(req.file.buffer, folder);
    return handleResponse(res, 200, "Uploaded", { url });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
