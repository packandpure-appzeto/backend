import Admin from "../models/admin.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";

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

const generateToken = (admin) =>
    jwt.sign(
        { id: admin._id, role: "admin" },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

/* ===============================
   ADMIN SIGNUP
================================ */
export const signupAdmin = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return handleResponse(res, 400, "Name, email and password are required");
        }

        let admin = await Admin.findOne({ email });

        if (admin) {
            return handleResponse(res, 400, "Admin already exists");
        }

        admin = await Admin.create({
            name,
            email,
            password,
        });

        const token = generateToken(admin);

        return handleResponse(res, 201, "Admin registered successfully", {
            token,
            admin,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   ADMIN LOGIN
================================ */
export const loginAdmin = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return handleResponse(res, 400, "Email and password are required");
        }

        const admin = await Admin.findOne({ email }).select("+password");

        if (!admin) {
            return handleResponse(res, 404, "Admin not found");
        }

        const isMatch = await admin.comparePassword(password);

        if (!isMatch) {
            return handleResponse(res, 401, "Invalid credentials");
        }

        admin.lastLogin = new Date();
        await admin.save();

        const token = generateToken(admin);

        return handleResponse(res, 200, "Login successful", {
            token,
            admin,
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
        let { email } = req.body;

        if (!email) {
            return handleResponse(res, 400, "Master Email Address is required");
        }
        
        email = email.trim().toLowerCase();

        const admin = await Admin.findOne({ email }).select("+otp +otpExpiry");

        if (!admin) {
            return handleResponse(res, 404, "No administrator found with this email");
        }

        if (!admin.isVerified) {
            return handleResponse(res, 403, "Your account is inactive. Please contact support.");
        }

        const otp = generateOTP();
        const otpExpiry = new Date(Date.now() + OTP_TTL_MS);

        admin.otp = otp;
        admin.otpExpiry = otpExpiry;
        await admin.save();

        logOtpDev("Admin Forgot Password", otp);

        return handleResponse(res, 200, "OTP sent successfully", {
            email,
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
        let { email, otp, newPassword } = req.body;

        if (!email || !otp) {
            return handleResponse(res, 400, "Email and OTP are required");
        }
        
        email = email.trim().toLowerCase();
        otp = String(otp).trim();

        if (!newPassword || newPassword.length !== 6) {
            return handleResponse(res, 400, "PIN must be exactly 6 characters");
        }

        const admin = await Admin.findOne({ email }).select("+otp +otpExpiry +password");

        if (!admin) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        const expired = !admin.otpExpiry || admin.otpExpiry.getTime() <= Date.now();
        const otpMatch = admin.otp === otp;

        if (!otpMatch || expired) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        if (!admin.isVerified) {
            return handleResponse(res, 403, "Your account is inactive. Please contact support.");
        }

        admin.password = newPassword;
        admin.otp = undefined;
        admin.otpExpiry = undefined;
        admin.lastLogin = new Date();

        await admin.save();

        const token = generateToken(admin);

        return handleResponse(res, 200, "Password reset successfully. Logging you in...", {
            token,
            admin,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};