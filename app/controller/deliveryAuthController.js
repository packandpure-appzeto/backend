import Delivery from "../models/delivery.js";
import DeliveryActivity from "../models/deliveryActivity.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import { generateOTP, useRealSMS } from "../utils/otp.js";
import Joi from "joi";

const signupSchema = Joi.object({
    name: Joi.string().trim().min(2).max(50).pattern(/^[a-zA-Z\s]+$/).required().messages({
        "string.pattern.base": "Name must contain only letters and spaces",
    }),
    phone: Joi.string().pattern(/^[6-9]\d{9}$/).required().messages({
        "string.pattern.base": "Please provide a valid 10-digit Indian phone number",
    }),
    email: Joi.string().trim().lowercase().email().required(),
    vehicleType: Joi.string().valid("bike", "scooter", "cycle").required(),
    address: Joi.string().trim().min(10).required(),
    vehicleNumber: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/).required(),
    drivingLicenseNumber: Joi.string().trim().uppercase().min(10).max(20).required(),
    aadharNumber: Joi.string().pattern(/^\d{12}$/).required(),
    panNumber: Joi.string().trim().uppercase().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).required(),
    accountHolder: Joi.string().trim().min(2).required(),
    accountNumber: Joi.string().pattern(/^\d{9,18}$/).required(),
    ifsc: Joi.string().trim().uppercase().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).required(),
});
const generateToken = (delivery) =>
    jwt.sign(
        { id: delivery._id, role: "delivery" },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

/* ===============================
   SIGNUP – Send OTP
================================ */
export const signupDelivery = async (req, res) => {
    try {
        const { error, value } = signupSchema.validate(req.body);
        if (error) {
            return handleResponse(res, 400, error.details[0].message);
        }

        const {
            name, phone, vehicleType, email, address, vehicleNumber,
            drivingLicenseNumber, aadharNumber, panNumber,
            accountHolder, accountNumber, ifsc
        } = value;

        let delivery = await Delivery.findOne({ phone });

        if (delivery && delivery.isVerified) {
            return handleResponse(res, 400, "Delivery partner already exists and is verified.");
        }

        const otp = generateOTP();

        let aadharUrl = delivery?.documents?.aadhar || "";
        let panUrl = delivery?.documents?.pan || "";
        let dlUrl = delivery?.documents?.drivingLicense || "";

        if (req.files) {
            if (req.files.aadhar && req.files.aadhar[0]) {
                aadharUrl = await uploadToCloudinary(req.files.aadhar[0].buffer, 'delivery_docs');
            }
            if (req.files.pan && req.files.pan[0]) {
                panUrl = await uploadToCloudinary(req.files.pan[0].buffer, 'delivery_docs');
            }
            if (req.files.dl && req.files.dl[0]) {
                dlUrl = await uploadToCloudinary(req.files.dl[0].buffer, 'delivery_docs');
            }
        }

        const deliveryData = {
            name, phone, vehicleType, email, address, vehicleNumber, drivingLicenseNumber,
            aadharNumber, panNumber, accountHolder, accountNumber, ifsc,
            documents: { aadhar: aadharUrl, pan: panUrl, drivingLicense: dlUrl },
            otp, otpExpiry: Date.now() + 5 * 60 * 1000,
        };

        if (!delivery) {
            delivery = await Delivery.create(deliveryData);
        } else {
            Object.assign(delivery, deliveryData);
            await delivery.save();
        }

        console.log("-------------------");
        console.log("Delivery Signup Request Received");
        console.log("Data:", { name, phone, vehicleType, email });
        if (useRealSMS()) {
            console.log("Generated OTP (real SMS mode):", otp);
        } else {
            console.log("OTP (mock mode): use 1234");
        }
        console.log("-------------------");

        return handleResponse(res, 200, "OTP sent successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   LOGIN – Send OTP
================================ */
export const loginDelivery = async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return handleResponse(res, 400, "Phone number is required");
        }

        const delivery = await Delivery.findOne({ phone });

        if (!delivery) {
            return handleResponse(res, 400, "Delivery partner not found. Please signup first.");
        }

        const otp = generateOTP();

        delivery.otp = otp;
        delivery.otpExpiry = Date.now() + 5 * 60 * 1000;
        await delivery.save();

        console.log("-------------------");
        console.log("Delivery Login Request Received");
        console.log("Phone:", phone);
        if (useRealSMS()) {
            console.log("Generated OTP (real SMS mode):", otp);
        } else {
            console.log("OTP (mock mode): use 1234");
        }
        console.log("-------------------");

        return handleResponse(res, 200, "OTP sent successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   VERIFY OTP
================================ */
export const verifyDeliveryOTP = async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return handleResponse(res, 400, "Phone and OTP are required");
        }

        const delivery = await Delivery.findOne({
            phone,
            otp,
            otpExpiry: { $gt: Date.now() },
        });

        if (!delivery) {
            return handleResponse(res, 400, "Invalid or expired OTP");
        }

        // SOP Update: OTP verification only proves the phone number. 
        // Verification (Approval) must be done by Admin manually.
        // delivery.isVerified = true; 
        delivery.isOnline = true; 
        delivery.otp = undefined;
        delivery.otpExpiry = undefined;
        delivery.lastLogin = new Date();

        await delivery.save();

        const locationObj = delivery.location?.coordinates?.length === 2 ? delivery.location : undefined;
        await DeliveryActivity.insertMany([
            { deliveryBoy: delivery._id, type: "login", location: locationObj, area: delivery.currentArea },
            { deliveryBoy: delivery._id, type: "online", location: locationObj, area: delivery.currentArea }
        ]);

        const token = generateToken(delivery);

        return handleResponse(res, 200, "Login successful", {
            token,
            delivery,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   GET PROFILE
================================ */
export const getDeliveryProfile = async (req, res) => {
    try {
        const delivery = await Delivery.findById(req.user.id);
        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }
        return handleResponse(res, 200, "Profile fetched successfully", delivery);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   UPDATE PROFILE
================================ */
export const updateDeliveryProfile = async (req, res) => {
    try {
        const { name, vehicleType, vehicleNumber, drivingLicenseNumber, currentArea, isOnline, profileImage } = req.body;

        const delivery = await Delivery.findById(req.user.id);
        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        if (name) delivery.name = name;
        if (vehicleType) delivery.vehicleType = vehicleType;
        if (vehicleNumber) delivery.vehicleNumber = vehicleNumber;
        if (drivingLicenseNumber) delivery.drivingLicenseNumber = drivingLicenseNumber;
        if (currentArea) delivery.currentArea = currentArea;
        if (profileImage) {
            delivery.documents = delivery.documents || {};
            delivery.documents.profileImage = profileImage;
        }
        let statusChanged = false;
        if (typeof isOnline !== 'undefined' && delivery.isOnline !== isOnline) {
            delivery.isOnline = isOnline;
            statusChanged = true;
        }

        await delivery.save();

        if (statusChanged) {
            const locationObj = delivery.location?.coordinates?.length === 2 ? delivery.location : undefined;
            await DeliveryActivity.create({
                deliveryBoy: delivery._id,
                type: delivery.isOnline ? "online" : "offline",
                location: locationObj,
                area: delivery.currentArea
            });
        }

        return handleResponse(res, 200, "Profile updated successfully", delivery);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   LOGOUT
================================ */
export const logoutDelivery = async (req, res) => {
    try {
        const delivery = await Delivery.findById(req.user.id);
        if (!delivery) {
            return handleResponse(res, 404, "Delivery partner not found");
        }

        let statusChanged = false;
        if (delivery.isOnline) {
            delivery.isOnline = false;
            statusChanged = true;
            await delivery.save();
        }

        const locationObj = delivery.location?.coordinates?.length === 2 ? delivery.location : undefined;
        const activities = [{ deliveryBoy: delivery._id, type: "logout", location: locationObj, area: delivery.currentArea }];
        
        if (statusChanged) {
            activities.push({ deliveryBoy: delivery._id, type: "offline", location: locationObj, area: delivery.currentArea });
        }

        await DeliveryActivity.insertMany(activities);

        return handleResponse(res, 200, "Logged out successfully");
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};