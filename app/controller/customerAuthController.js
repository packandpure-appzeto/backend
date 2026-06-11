import Customer from "../models/customer.js";
import Transaction from "../models/transaction.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";
import { normalizePhone, isValidIndianPhone } from "../utils/phone.js";
import {
    SUSPENDED_MESSAGE,
    getPlatformSupportContact,
} from "../utils/supportContact.js";

const OTP_TTL_MS = 5 * 60 * 1000;

const generateToken = (customer) =>
    jwt.sign(
        { id: customer._id, role: "customer" },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

const logOtpDev = (label, otp) => {
    if (useRealSMS()) {
        console.log(`${label} OTP (real SMS mode):`, otp);
    } else {
        console.log(`${label} OTP (mock mode): use 1234`);
    }
};

/* ===============================
   SEND OTP — login + auto-register
   If phone not in DB → create minimal account
================================ */
export const sendCustomerOtp = async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);

        if (!isValidIndianPhone(phone)) {
            return handleResponse(res, 400, "Enter a valid 10-digit mobile number");
        }

        const otp = generateOTP();
        const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

        let customer = await Customer.findOne({ phone }).select("+otp +otpExpiry");
        let isNewUser = false;

        if (!customer) {
            customer = await Customer.create({
                phone,
                role: "customer",
                otp,
                otpExpiry,
            });
            isNewUser = true;
        } else {
            customer.otp = otp;
            customer.otpExpiry = otpExpiry;
            await customer.save();
        }

        logOtpDev(isNewUser ? "New user" : "Login", otp);

        return handleResponse(res, 200, "OTP sent successfully", {
            isNewUser,
            phone,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return handleResponse(res, 409, "Phone number already in use");
        }
        return handleResponse(res, 500, error.message);
    }
};

/** @deprecated Use sendCustomerOtp — kept for older clients */
export const loginCustomer = sendCustomerOtp;

/* ===============================
   VERIFY OTP
================================ */
export const verifyCustomerOTP = async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);
        const otp = String(req.body?.otp ?? "").trim();

        if (!isValidIndianPhone(phone) || !otp) {
            return handleResponse(res, 400, "Phone and OTP are required");
        }

        const customer = await Customer.findOne({ phone }).select("+otp +otpExpiry");

        if (!customer) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        const expired = !customer.otpExpiry || customer.otpExpiry.getTime() <= Date.now();
        const otpMatch = customer.otp === otp;

        if (!otpMatch || expired) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        if (!customer.isActive) {
            const support = await getPlatformSupportContact();
            customer.otp = undefined;
            customer.otpExpiry = undefined;
            await customer.save();
            return handleResponse(res, 403, SUSPENDED_MESSAGE, {
                suspended: true,
                supportEmail: support.supportEmail,
                supportPhone: support.supportPhone,
            });
        }

        customer.isVerified = true;
        customer.otp = undefined;
        customer.otpExpiry = undefined;
        customer.lastLogin = new Date();

        await customer.save();

        const token = generateToken(customer);
        const publicCustomer = customer.toPublicJSON();

        return handleResponse(res, 200, "Login successful", {
            token,
            customer: publicCustomer,
            isNewUser: !publicCustomer.name,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   GET PROFILE
================================ */
export const getCustomerProfile = async (req, res) => {
    try {
        const customer = await Customer.findById(req.user.id);
        if (!customer) {
            return handleResponse(res, 404, "Customer not found");
        }
        if (!customer.isActive) {
            const support = await getPlatformSupportContact();
            return handleResponse(res, 403, SUSPENDED_MESSAGE, {
                suspended: true,
                supportEmail: support.supportEmail,
                supportPhone: support.supportPhone,
            });
        }
        return handleResponse(res, 200, "Profile fetched successfully", customer.toPublicJSON());
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   UPDATE PROFILE
================================ */
export const updateCustomerProfile = async (req, res) => {
    try {
        const { name, email, addresses, businessName, businessAddress, contactPerson, panNo, gstNo, fssaiNumber, avatar } =
            req.body;

        const customer = await Customer.findById(req.user.id);
        if (!customer) {
            return handleResponse(res, 404, "Customer not found");
        }

        if (name !== undefined) customer.name = String(name).trim();
        if (email !== undefined) customer.email = email ? String(email).trim().toLowerCase() : undefined;
        if (businessName !== undefined) customer.businessName = businessName;
        if (businessAddress !== undefined) customer.businessAddress = businessAddress;
        if (contactPerson !== undefined) customer.contactPerson = contactPerson;
        if (panNo !== undefined) customer.panNo = panNo;
        if (gstNo !== undefined) customer.gstNo = gstNo;
        if (fssaiNumber !== undefined) customer.fssaiNumber = fssaiNumber;
        if (addresses !== undefined) customer.addresses = addresses;
        if (avatar !== undefined) customer.avatar = avatar ? String(avatar).trim() : "";

        await customer.save();

        return handleResponse(res, 200, "Profile updated successfully", customer.toPublicJSON());
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const registerCustomerFcmToken = async (req, res) => {
    try {
        const { token } = req.body;
        if (!token || typeof token !== "string") {
            return handleResponse(res, 400, "A valid FCM token is required");
        }

        const customer = await Customer.findById(req.user.id);
        if (!customer) {
            return handleResponse(res, 404, "Customer not found");
        }

        customer.fcmTokens = Array.from(
            new Set([...(customer.fcmTokens || []), token.trim()]),
        );
        await customer.save();

        return handleResponse(res, 200, "FCM token registered successfully", {
            tokens: customer.fcmTokens,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

export const removeCustomerFcmToken = async (req, res) => {
    try {
        const { token } = req.body;
        if (!token || typeof token !== "string") {
            return handleResponse(res, 400, "A valid FCM token is required");
        }

        const customer = await Customer.findById(req.user.id);
        if (!customer) {
            return handleResponse(res, 404, "Customer not found");
        }

        customer.fcmTokens = (customer.fcmTokens || []).filter(
            (existing) => existing !== token.trim(),
        );
        await customer.save();

        return handleResponse(res, 200, "FCM token removed successfully", {
            tokens: customer.fcmTokens,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   GET WALLET TRANSACTIONS
================================ */
export const getCustomerTransactions = async (req, res) => {
    try {
        const customerId = req.user.id;
        const { page = 1, limit = 20 } = req.query;
        const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(50, Math.max(1, parseInt(limit, 10)));
        const perPage = Math.min(50, Math.max(1, parseInt(limit, 10)));

        const [transactions, total] = await Promise.all([
            Transaction.find({ user: customerId, userModel: "User" })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(perPage)
                .populate("order", "orderId")
                .lean(),
            Transaction.countDocuments({ user: customerId, userModel: "User" }),
        ]);

        const items = transactions.map((t) => ({
            _id: t._id,
            type: t.type === "Refund" ? "credit" : "debit",
            title: t.type === "Refund" ? "Refund" : t.type,
            amount: Math.abs(t.amount),
            date: t.createdAt,
            reference: t.reference,
            orderId: t.order?.orderId,
        }));

        return handleResponse(res, 200, "Transactions fetched", {
            items,
            total,
            page: parseInt(page, 10),
            totalPages: Math.ceil(total / perPage) || 1,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
