import Seller from "../models/seller.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import Admin from "../models/admin.js";
import Notification from "../models/notification.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";
import { normalizePhone, isValidIndianPhone } from "../utils/phone.js";

const OTP_TTL_MS = 5 * 60 * 1000;

const logOtpDev = (label, otp) => {
    if (useRealSMS()) {
        console.log(`${label} OTP (real SMS mode):`, otp);
    } else {
        console.log(`${label} OTP (mock mode): use 1234`);
    }
};

/* ===============================
   Utils
================================ */

const generateToken = (seller) =>
    jwt.sign(
        { id: seller._id, role: "seller" },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

/* ===============================
   SELLER SIGNUP
================================ */
export const signupSeller = async (req, res) => {
    try {
        const { name, email, phone, password, shopName, address, lat, lng, radius, description, category } = req.body;

        if (!name || !email || !phone || !password || !shopName) {
            return handleResponse(res, 400, "All fields are required");
        }

        // Validate coordinates and radius if provided
        if (lat !== undefined && (lat < -90 || lat > 90)) {
            return handleResponse(res, 400, "Invalid latitude");
        }
        if (lng !== undefined && (lng < -180 || lng > 180)) {
            return handleResponse(res, 400, "Invalid longitude");
        }
        if (radius !== undefined && (radius < 1 || radius > 100)) {
            return handleResponse(res, 400, "Radius must be between 1 and 100 km");
        }

        let seller = await Seller.findOne({ $or: [{ email }, { phone }] });

        if (seller) {
            return handleResponse(res, 400, "Seller with this email or phone already exists");
        }

        const sellerData = {
            name,
            email,
            phone,
            password,
            shopName,
            address: address || "",
            description: description || "",
            category: category || "General",
            documents: {}
        };

        // Handle SOP Documents
        if (req.files) {
            if (req.files.tradeLicense && req.files.tradeLicense[0]) {
                sellerData.documents.tradeLicense = await uploadToCloudinary(req.files.tradeLicense[0].buffer, "seller_docs");
            }
            if (req.files.gstCertificate && req.files.gstCertificate[0]) {
                sellerData.documents.gstCertificate = await uploadToCloudinary(req.files.gstCertificate[0].buffer, "seller_docs");
            }
            if (req.files.idProof && req.files.idProof[0]) {
                sellerData.documents.idProof = await uploadToCloudinary(req.files.idProof[0].buffer, "seller_docs");
            }
        }

        if (lat !== undefined && lng !== undefined) {
            sellerData.location = {
                type: "Point",
                coordinates: [Number(lng), Number(lat)],
            };
        }

        if (radius !== undefined) {
            sellerData.serviceRadius = Number(radius);
        }

        seller = await Seller.create(sellerData);

        // --- NOTIFY ADMINS ---
        try {
            const admins = await Admin.find({}, '_id');
            const notifications = admins.map(admin => ({
                recipient: admin._id,
                recipientModel: 'Admin',
                title: 'New Vendor Registration',
                message: `New Vendor Registered: ${seller.shopName} - Category: ${seller.category}. Awaiting Approval.`,
                type: 'system',
                data: { sellerId: seller._id }
            }));
            if (notifications.length > 0) {
                await Notification.insertMany(notifications);
            }
        } catch (notifErr) {
            console.error("Error creating admin notification for new vendor:", notifErr);
        }
        // ---------------------

        const token = generateToken(seller);

        return handleResponse(res, 201, "Seller registered successfully", {
            token,
            seller,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};


/* ===============================
   SELLER LOGIN
================================ */
export const loginSeller = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return handleResponse(res, 400, "Email and password are required");
        }

        // Include password for comparison
        const seller = await Seller.findOne({ email }).select("+password");

        if (!seller) {
            return handleResponse(res, 404, "Seller not found");
        }

        const isMatch = await seller.comparePassword(password);

        if (!isMatch) {
            return handleResponse(res, 401, "Invalid credentials");
        }

        seller.lastLogin = new Date();
        await seller.save();

        const token = generateToken(seller);

        return handleResponse(res, 200, "Login successful", {
            token,
            seller,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   FORGOT PASSWORD OTP
================================ */
export const forgotPasswordOtp = async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);

        if (!isValidIndianPhone(phone)) {
            return handleResponse(res, 400, "Enter a valid 10-digit mobile number");
        }

        const seller = await Seller.findOne({ phone }).select("+otp +otpExpiry");

        if (!seller) {
            return handleResponse(res, 404, "No seller found with this phone number");
        }

        if (!seller.isActive) {
            return handleResponse(res, 403, "Your account is suspended. Please contact support.");
        }

        const otp = generateOTP();
        const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

        seller.otp = otp;
        seller.otpExpiry = otpExpiry;
        await seller.save();

        logOtpDev("Seller Forgot Password", otp);

        return handleResponse(res, 200, "OTP sent successfully", {
            phone,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   RESET PASSWORD WITH OTP
================================ */
export const resetPasswordWithOtp = async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);
        const otp = String(req.body?.otp ?? "").trim();
        const { newPassword } = req.body;

        if (!isValidIndianPhone(phone) || !otp) {
            return handleResponse(res, 400, "Phone and OTP are required");
        }

        if (!newPassword || newPassword.length !== 6) {
            return handleResponse(res, 400, "PIN must be exactly 6 characters");
        }

        const seller = await Seller.findOne({ phone }).select("+otp +otpExpiry +password");

        if (!seller) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        const expired = !seller.otpExpiry || seller.otpExpiry.getTime() <= Date.now();
        const otpMatch = seller.otp === otp;

        if (!otpMatch || expired) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        if (!seller.isActive) {
            return handleResponse(res, 403, "Your account is suspended. Please contact support.");
        }

        seller.password = newPassword;
        seller.otp = undefined;
        seller.otpExpiry = undefined;
        seller.lastLogin = new Date();

        await seller.save();

        const token = generateToken(seller);

        return handleResponse(res, 200, "Password reset successfully. Logging you in...", {
            token,
            seller,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
