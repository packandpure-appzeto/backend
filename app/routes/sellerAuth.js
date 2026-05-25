import express from "express";
import { signupSeller, loginSeller } from "../controller/sellerAuthController.js";
import upload from "../middleware/uploadMiddleware.js";
import {
    getSellerProfile,
    updateSellerProfile,
    requestWithdrawal,
    getNearbySellers,
    sellerReverseGeocode,
    sellerGeocodeAddress,
} from "../controller/sellerController.js";
import { getSellerStats, getSellerEarnings } from "../controller/sellerStatsController.js";
import {
    getSellerPurchaseRequests,
    respondSellerPurchaseRequest,
    markSellerRequestReady,
    confirmSellerHandover,
} from "../controller/purchaseRequestController.js";
import { verifyToken, allowRoles, isAccountVerified } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post(
    "/signup",
    upload.fields([
        { name: "tradeLicense", maxCount: 1 },
        { name: "gstCertificate", maxCount: 1 },
        { name: "idProof", maxCount: 1 },
    ]),
    signupSeller
);
router.post("/login", loginSeller);
router.get("/nearby", getNearbySellers);

// Profile routes
router.get(
    "/profile",
    verifyToken,
    allowRoles("seller"),
    getSellerProfile
);

router.put(
    "/profile",
    verifyToken,
    allowRoles("seller"),
    updateSellerProfile
);

router.get(
    "/location/reverse-geocode",
    verifyToken,
    allowRoles("seller"),
    sellerReverseGeocode
);

router.post(
    "/location/geocode-address",
    verifyToken,
    allowRoles("seller"),
    sellerGeocodeAddress
);

// Analytics & Financials
router.get("/stats", verifyToken, allowRoles("seller"), getSellerStats);
router.get("/earnings", verifyToken, allowRoles("seller"), getSellerEarnings);
router.post("/request-withdrawal", verifyToken, allowRoles("seller"), isAccountVerified, requestWithdrawal);

// Procurement / purchase requests (Seller SOP flow)
router.get(
    "/purchase-requests",
    verifyToken,
    allowRoles("seller"),
    getSellerPurchaseRequests,
);
router.post(
    "/purchase-requests/:id/respond",
    verifyToken,
    allowRoles("seller"),
    isAccountVerified,
    respondSellerPurchaseRequest,
);
router.post(
    "/purchase-requests/:id/ready",
    verifyToken,
    allowRoles("seller"),
    isAccountVerified,
    markSellerRequestReady,
);
router.post(
    "/purchase-requests/:id/handover",
    verifyToken,
    allowRoles("seller"),
    isAccountVerified,
    confirmSellerHandover,
);

export default router;
