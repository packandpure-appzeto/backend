import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import handleResponse from "../utils/helper.js";
import {
  SUSPENDED_MESSAGE,
  getPlatformSupportContact,
} from "../utils/supportContact.js";

/** JWT may use `user` or `customer` for storefront accounts — normalize to `customer`. */
export const normalizeAuthRole = (role) => {
  if (role === "user") return "customer";
  return role;
};

const ROLE_MODEL = {
  admin: "Admin",
  seller: "Seller",
  delivery: "Delivery",
  pickup_partner: "PickupPartner",
  customer: "User",
};

/* ===============================
   Verify Token
================================ */
export const verifyToken = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return handleResponse(res, 401, "Unauthorized, token missing");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const role = normalizeAuthRole(decoded.role);
    const id = decoded.id;

    const modelName = ROLE_MODEL[role];
    if (!modelName) {
      return handleResponse(res, 401, "Invalid token role");
    }

    const exists = await mongoose.model(modelName).exists({ _id: id });
    if (!exists) {
      return handleResponse(res, 401, "Account no longer exists. Please login again.");
    }

    if (role === "customer") {
      const customer = await mongoose
        .model("User")
        .findById(id)
        .select("isActive")
        .lean();
      if (customer && customer.isActive === false) {
        const support = await getPlatformSupportContact();
        return handleResponse(res, 403, SUSPENDED_MESSAGE, {
          suspended: true,
          supportEmail: support.supportEmail,
          supportPhone: support.supportPhone,
        });
      }
    }

    req.user = { ...decoded, id, role };
    next();
  } catch (error) {
    return handleResponse(res, 401, "Invalid or expired token");
  }
};

/* ===============================
   Role Based Access
================================ */
export const allowRoles = (...roles) => {
  const allowed = new Set(roles.map(normalizeAuthRole));
  if (allowed.has("customer")) allowed.add("user");
  if (roles.includes("user")) allowed.add("customer");

  return (req, res, next) => {
    const role = normalizeAuthRole(req.user?.role);
    if (!role || !allowed.has(role)) {
      return handleResponse(res, 403, "Access denied");
    }
    req.user.role = role;
    next();
  };
};

/** Shorthand guards aligned with platform roles */
export const requireCustomer = allowRoles("customer");
export const requireSeller = allowRoles("seller");
export const requireDelivery = allowRoles("delivery");
export const requirePickupPartner = allowRoles("pickup_partner");
export const requireAdmin = allowRoles("admin");

/* ===============================
   Verification Check (seller, delivery, pickup)
================================ */
export const isAccountVerified = async (req, res, next) => {
  try {
    const { id, role } = req.user;
    let modelName = "";

    if (role === "seller") modelName = "Seller";
    else if (role === "delivery") modelName = "Delivery";
    else if (role === "pickup_partner") modelName = "PickupPartner";
    else return next();

    const account = await mongoose.model(modelName).findById(id).select("isVerified").lean();

    if (!account || !account.isVerified) {
      return handleResponse(
        res,
        403,
        "Access Denied: Your account is pending admin approval. You can login but cannot perform operational tasks yet.",
      );
    }

    next();
  } catch (error) {
    return handleResponse(res, 500, "Verification check failed");
  }
};
